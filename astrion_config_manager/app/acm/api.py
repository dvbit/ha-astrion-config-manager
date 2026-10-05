"""aiohttp application: Ingress panel + JSON API (spec RF1-RF5, RNF1).

All URLs are relative so the panel works behind the Ingress path prefix.
Business errors are returned as ``{"error": <code>, ...}`` and translated by
the frontend (RNF3).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import aiohttp
from aiohttp import web

from . import copying
from .actions import Executor
from .canonical import canonical_hash
from .device import DeviceClient, DeviceError
from .ha import HAClient, HAError
from .harmony import HarmonyRegistry
from .icons import IconLibrary, collect_refs, sanitize
from .store import T_SYNC_IMPORT, Store, StoreError, clean_fields
from .validate import HARDWARE_KEYS, validate

_LOGGER = logging.getLogger(__name__)

STATIC = Path(__file__).parent / "static"

# Spec "Ingress": only the Supervisor ingress gateway may connect.
INGRESS_IP = "172.30.32.2"

K_STORE = web.AppKey("store", Store)
K_HA = web.AppKey("ha", HAClient)
K_HTTP = web.AppKey("http", aiohttp.ClientSession)
K_LOCKS = web.AppKey("locks", defaultdict)
K_DEVICE = web.AppKey("device_factory", object)
K_EXEC = web.AppKey("executor", Executor)
K_HARMONY = web.AppKey("harmony", HarmonyRegistry)
K_ICONS = web.AppKey("icons", IconLibrary)
K_DEV_ICONS = web.AppKey("device_icons", dict)  # rid -> (monotonic, set of names)
K_HA_OK = web.AppKey("ha_ok", dict)  # mutable holder: app state is frozen after start

# Patch operations listed per version in the history view (RF2.7).
SUMMARY_OPS = 8

# Drift states shown in the remote list (RF5.2, RF5.5).
DRIFT_IN_SYNC = "in_sync"
DRIFT_DRIFT = "drift"
DRIFT_UNREACHABLE = "unreachable"
DRIFT_MISSING = "missing"
DRIFT_INVALID = "invalid"


# --------------------------------------------------------------------------
# Middlewares
# --------------------------------------------------------------------------


@web.middleware
async def ingress_only(request: web.Request, handler):
    """Deny any client other than the Ingress gateway (RNF1)."""
    if os.environ.get("ACM_ALLOW_ANY") != "1" and request.remote != INGRESS_IP:
        _LOGGER.warning("Rejected request from %s", request.remote)
        raise web.HTTPForbidden()
    return await handler(request)


@web.middleware
async def errors(request: web.Request, handler):
    """Map domain exceptions to JSON error responses."""
    try:
        return await handler(request)
    except StoreError as err:
        return web.json_response({"error": err.code, **err.details}, status=err.status)
    except copying.CopyError as err:
        return web.json_response({"error": err.code}, status=400)
    except DeviceError as err:
        _LOGGER.warning("Device error on %s: %s", request.path, err)
        status = 503 if err.code == "unreachable" else 502
        return web.json_response({"error": err.code, "detail": err.detail}, status=status)
    except web.HTTPException:
        raise
    except Exception:  # pragma: no cover - last resort, logged with traceback
        _LOGGER.exception("Unhandled error on %s %s", request.method, request.path)
        return web.json_response({"error": "internal"}, status=500)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _user(request: web.Request) -> str | None:
    """HA user from the Ingress headers (RF2.1 'utente HA')."""
    return (
        request.headers.get("X-Remote-User-Display-Name")
        or request.headers.get("X-Remote-User-Name")
        or request.headers.get("X-Remote-User-Id")
    )


async def _body(request: web.Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except ValueError:
        raise StoreError("bad_request") from None
    if not isinstance(data, dict):
        raise StoreError("bad_request")
    return data


def _int(value: Any, code: str = "bad_request") -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise StoreError(code) from None


def _device(app: web.Application, meta: dict[str, Any]) -> DeviceClient:
    return app[K_DEVICE](app[K_HTTP], meta["host"], meta["port"])


async def _known_entities(app: web.Application) -> set[str] | None:
    """Entity ids from HA, or None when HA cannot be queried (RF4.2)."""
    try:
        known = await app[K_HA].entity_ids()
    except HAError as err:
        # Log the transition only, not every edit (RF4.4 validates on each change).
        if app[K_HA_OK]["ok"]:
            _LOGGER.warning("Cannot query HA entities: %s", err)
        else:
            _LOGGER.debug("HA still unreachable: %s", err)
        app[K_HA_OK]["ok"] = False
        return None
    if not app[K_HA_OK]["ok"]:
        _LOGGER.info("Home Assistant entity list available (%s entities)", len(known))
    app[K_HA_OK]["ok"] = True
    return known


# Remote icon lists are cached briefly: validation runs on every edit (RF4.4).
DEVICE_ICONS_TTL = 30.0


async def _device_icons(app: web.Application, meta: dict[str, Any], force: bool = False) -> set[str]:
    """Icon names on the remote (RF7.3); raises DeviceError if unreachable."""
    cached = app[K_DEV_ICONS].get(meta["id"])
    if not force and cached and time.monotonic() - cached[0] < DEVICE_ICONS_TTL:
        return cached[1]
    names = await _device(app, meta).icons_list()
    app[K_DEV_ICONS][meta["id"]] = (time.monotonic(), names)
    return names


async def _known_icons(app: web.Application, meta: dict[str, Any] | None) -> set[str] | None:
    """Library + remote icons; None when the remote list is unknown (RF7.4)."""
    if meta is None:
        return None
    try:
        return app[K_ICONS].names() | await _device_icons(app, meta)
    except DeviceError as err:
        _LOGGER.debug("Icon list of '%s' unavailable: %s", meta["name"], err)
        return None


def _known_devices(meta: dict[str, Any] | None) -> dict[str, set[str]] | None:
    """RF8.6: hub/extender ids read from the remote; None if never read."""
    if not meta or not meta.get("devices_read_at"):
        return None
    return {
        "hubs": {h["localId"] for h in meta.get("harmony_hubs") or []},
        "extenders": {e["localId"] for e in meta.get("extenders") or []},
    }


async def _refresh_devices(app: web.Application, rid: str) -> None:
    """RF8.1: re-read hubs/extenders from the remote (best effort)."""
    store = app[K_STORE]
    meta = store.remote_info(rid)
    try:
        cfg = await _device(app, meta).devices_config()
    except DeviceError as err:
        _LOGGER.warning("Cannot read hubs/extenders of '%s': %s %s", meta["name"], err.code, err.detail)
        return
    store.set_devices(rid, cfg["harmony_hubs"], cfg["extenders"])


async def _validation(app: web.Application, doc: Any, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    return validate(doc, await _known_entities(app), await _known_icons(app, meta), _known_devices(meta))


def _summary(ver: dict[str, Any]) -> dict[str, Any]:
    """Version metadata + readable delta summary (RF2.7)."""
    ops = [{"op": p["op"], "path": p["path"]} for p in ver["patch"][:SUMMARY_OPS]]
    out = {k: v for k, v in ver.items() if k != "patch"}
    out.update({"ops": ops, "op_count": len(ver["patch"])})
    return out


async def _drift(app: web.Application, meta: dict[str, Any]) -> dict[str, Any]:
    """RF5.2: compare canonical hash of the device file with the baseline."""
    try:
        pulled = await _device(app, meta).pull()
    except DeviceError as err:
        status = {"file_missing": DRIFT_MISSING, "invalid_json": DRIFT_INVALID}.get(err.code, DRIFT_UNREACHABLE)
        _LOGGER.info("Drift check '%s': %s (%s)", meta["name"], status, err.detail or err.code)
        return {"status": status, "pulled": None}
    status = DRIFT_IN_SYNC if pulled.hash == meta.get("baseline") else DRIFT_DRIFT
    if status == DRIFT_DRIFT:
        _LOGGER.warning("Drift detected on '%s'", meta["name"])
    else:
        _LOGGER.debug("Drift check '%s': in sync", meta["name"])
    return {"status": status, "pulled": pulled}


# --------------------------------------------------------------------------
# Handlers - remotes (RF1)
# --------------------------------------------------------------------------


async def index(request: web.Request) -> web.FileResponse:
    """Serve the panel."""
    return web.FileResponse(STATIC / "index.html")


async def meta_info(request: web.Request) -> web.Response:
    """Return the current user and static references for the frontend."""
    return web.json_response({"user": _user(request), "hardware_keys": sorted(HARDWARE_KEYS)})


async def entities(request: web.Request) -> web.Response:
    """Entity ids for the editor's autocomplete (empty when HA is unreachable)."""
    known = await _known_entities(request.app)
    return web.json_response(sorted(known or []))


async def list_remotes(request: web.Request) -> web.Response:
    """RF1.4 / RF5.5: main list or archive view."""
    archived = request.query.get("archived") == "1"
    return web.json_response(request.app[K_STORE].list_remotes(archived))


async def create_remote(request: web.Request) -> web.Response:
    """RF1.2: initial pull; on failure nothing is registered."""
    fields = await _body(request)
    store = request.app[K_STORE]
    # Validate fields before touching the network (RF1.1).
    clean = clean_fields(fields, partial=False)
    store.check_unique_name(clean["name"])
    pulled = await request.app[K_DEVICE](request.app[K_HTTP], clean["host"], clean["port"]).pull()
    info = store.create_remote(clean, pulled.content, _user(request), pulled.hash)
    await _refresh_devices(request.app, info["id"])  # RF8.1
    return web.json_response(store.remote_info(info["id"]), status=201)


async def update_remote(request: web.Request) -> web.Response:
    """RF1.3: edit any field."""
    rid = request.match_info["rid"]
    async with request.app[K_LOCKS][rid]:
        info = request.app[K_STORE].update_remote(rid, await _body(request))
    return web.json_response(info)


async def archive(request: web.Request) -> web.Response:
    """RF1.4: archive (``/archive``) or restore (``/unarchive``)."""
    rid = request.match_info["rid"]
    flag = request.path.endswith("/archive")
    async with request.app[K_LOCKS][rid]:
        info = request.app[K_STORE].set_archived(rid, flag)
    return web.json_response(info)


# --------------------------------------------------------------------------
# Handlers - versions (RF2) and editing (RF3, RF4)
# --------------------------------------------------------------------------


async def get_state(request: web.Request) -> web.Response:
    """State of the head or of ``?version=N``, plus validation of the head."""
    rid = request.match_info["rid"]
    store = request.app[K_STORE]
    hist = store.history(rid)
    vid = _int(request.query.get("version", hist.head))
    state = hist.state(vid)
    body: dict[str, Any] = {"remote": store.remote_info(rid), "version": vid, "state": state}
    if vid == hist.head:
        body["validation"] = await _validation(request.app, state, body["remote"])
    return web.json_response(body)


async def list_versions(request: web.Request) -> web.Response:
    """RF2.7 / RF2.13: history (newest first) with names."""
    rid = request.match_info["rid"]
    store = request.app[K_STORE]
    hist = store.history(rid)
    names = store.names(rid)
    items = []
    for ver in reversed(hist.versions):
        item = _summary(ver)
        item["name"] = names.get(str(ver["id"]))
        items.append(item)
    return web.json_response({"head": hist.head, "versions": items, **hist.undo_redo()})


async def get_version(request: web.Request) -> web.Response:
    """Full delta of one version (readable delta, RF2.7)."""
    rid = request.match_info["rid"]
    vid = _int(request.match_info["vid"])
    hist = request.app[K_STORE].history(rid)
    if vid < 1 or vid > hist.head:
        raise StoreError("version_not_found", 404)
    return web.json_response(hist.versions[vid - 1])


async def _after_version(request: web.Request, rid: str, ver: dict | None) -> web.Response:
    store = request.app[K_STORE]
    state = store.head_state(rid)
    return web.json_response(
        {
            "version": _summary(ver) if ver else None,
            "remote": store.remote_info(rid),
            "state": state,
            "validation": await _validation(request.app, state, store.remote_info(rid)),
        }
    )


async def commit(request: web.Request) -> web.Response:
    """RF2.3 / RF2.10: commit a new full state against the client's head."""
    rid = request.match_info["rid"]
    data = await _body(request)
    if "state" not in data:
        raise StoreError("bad_request")
    async with request.app[K_LOCKS][rid]:
        ver = request.app[K_STORE].commit(rid, _int(data.get("head")), data["state"], _user(request))
    return await _after_version(request, rid, ver)


async def undo(request: web.Request) -> web.Response:
    """RF2.4."""
    rid = request.match_info["rid"]
    data = await _body(request)
    async with request.app[K_LOCKS][rid]:
        ver = request.app[K_STORE].undo(rid, _int(data.get("head")), _user(request))
    return await _after_version(request, rid, ver)


async def redo(request: web.Request) -> web.Response:
    """RF2.5."""
    rid = request.match_info["rid"]
    data = await _body(request)
    async with request.app[K_LOCKS][rid]:
        ver = request.app[K_STORE].redo(rid, _int(data.get("head")), _user(request))
    return await _after_version(request, rid, ver)


async def restore(request: web.Request) -> web.Response:
    """RF2.6 / RF2.13."""
    rid = request.match_info["rid"]
    data = await _body(request)
    async with request.app[K_LOCKS][rid]:
        ver = request.app[K_STORE].restore(rid, _int(data.get("head")), _int(data.get("version")), _user(request))
    return await _after_version(request, rid, ver)


async def set_name(request: web.Request) -> web.Response:
    """RF2.11 / RF2.12: assign, rename or remove a version label."""
    rid = request.match_info["rid"]
    vid = _int(request.match_info["vid"])
    data = await _body(request)
    async with request.app[K_LOCKS][rid]:
        names = request.app[K_STORE].set_name(rid, vid, data.get("name"))
    return web.json_response(names)


async def validate_state(request: web.Request) -> web.Response:
    """RF4.4: validate an arbitrary (unsaved) state for inline errors."""
    data = await _body(request)
    meta = request.app[K_STORE].remote_info(str(data["rid"])) if data.get("rid") else None
    return web.json_response(await _validation(request.app, data.get("state"), meta))


async def copy_elements(request: web.Request) -> web.Response:
    """RF3.3: copy pages/cards into another remote as one version."""
    data = await _body(request)
    store = request.app[K_STORE]
    src, dst = str(data.get("src")), str(data.get("dst"))
    src_state = store.head_state(src)
    async with request.app[K_LOCKS][dst]:
        dst_state = store.head_state(dst)
        if data.get("kind") == "pages":
            new = copying.copy_pages(src_state, list(data.get("pages", [])), dst_state)
        elif data.get("kind") == "cards":
            new = copying.copy_cards(
                src_state,
                _int(data.get("src_page")),
                list(data.get("cards", [])),
                dst_state,
                _int(data.get("dst_page")),
            )
        else:
            raise StoreError("bad_request")
        ver = store.commit(dst, _int(data.get("head")), new, _user(request))
    _LOGGER.info("Copied %s from %s to %s", data.get("kind"), src, dst)
    return await _after_version(request, dst, ver)


# --------------------------------------------------------------------------
# Handlers - synchronisation (RF5)
# --------------------------------------------------------------------------


def _sync_info(meta: dict[str, Any], status: str) -> dict[str, Any]:
    return {"id": meta["id"], "status": status, "last_push_version": meta.get("last_push_version")}


async def drift_all(request: web.Request) -> web.Response:
    """RF5.2: run at panel opening for every non-archived remote."""
    store = request.app[K_STORE]
    metas = store.list_remotes(archived=False)
    results = await asyncio.gather(*(_drift(request.app, m) for m in metas))
    return web.json_response([_sync_info(m, r["status"]) for m, r in zip(metas, results, strict=True)])


async def drift_one(request: web.Request) -> web.Response:
    """RF5.2 for a single remote."""
    rid = request.match_info["rid"]
    meta = request.app[K_STORE].remote_info(rid)
    res = await _drift(request.app, meta)
    return web.json_response(_sync_info(meta, res["status"]))


async def pull(request: web.Request) -> web.Response:
    """RF5.1 / RF5.3 'importa come versione': sync-import if different."""
    rid = request.match_info["rid"]
    data = await _body(request)
    store = request.app[K_STORE]
    async with request.app[K_LOCKS][rid]:
        meta = store.remote_info(rid)
        pulled = await _device(request.app, meta).pull()
        ver = store.commit(rid, _int(data.get("head")), pulled.content, _user(request), T_SYNC_IMPORT)
        store.set_sync(rid, baseline=pulled.hash)
        await _refresh_devices(request.app, rid)  # RF8.1
    _LOGGER.info("Pull '%s': %s", meta["name"], f"v{ver['id']} created" if ver else "no changes")
    return await _after_version(request, rid, ver)


async def push(request: web.Request) -> web.Response:
    """RF5.4: validate -> drift check -> upload -> re-read and verify hash."""
    rid = request.match_info["rid"]
    data = await _body(request)
    store = request.app[K_STORE]
    async with request.app[K_LOCKS][rid]:
        hist = store.history(rid)
        if _int(data.get("head")) != hist.head:
            raise StoreError("head_changed", 409, head=hist.head)
        meta = store.remote_info(rid)
        head_state = hist.state(hist.head)
        # 0. fresh icon list of the remote (RF7.3/RF7.4); unreachable blocks
        device_icons = await _device_icons(request.app, meta, force=True)
        # 1. validation (RF4.5, icons included)
        check = validate(
            head_state,
            await _known_entities(request.app),
            request.app[K_ICONS].names() | device_icons,
            _known_devices(meta),
        )
        if not check["push_allowed"]:
            _LOGGER.warning("Push '%s' blocked: %s issue(s)", meta["name"], len(check["issues"]))
            code = "push_blocked" if check["entities_checked"] else "ha_unavailable"
            return web.json_response({"error": code, "validation": check}, status=422)
        # 2. drift check (RF5.2): unreachable blocks, drift is only reported (RF5.3)
        drift = await _drift(request.app, meta)
        if drift["status"] == DRIFT_UNREACHABLE:
            raise DeviceError("unreachable")
        # 3. upload missing icons from the library (RF7.3), then the file
        device = _device(request.app, meta)
        uploaded = []
        for name in sorted(set(collect_refs(head_state)) - device_icons):
            data, ctype = request.app[K_ICONS].read(name)
            await device.icon_upload(name, data, ctype)
            uploaded.append(name)
        if uploaded:
            request.app[K_DEV_ICONS].pop(rid, None)
            _LOGGER.info("Push '%s': %s icon(s) uploaded: %s", meta["name"], len(uploaded), ", ".join(uploaded))
        await device.upload(head_state)
        # 4. re-read and verify
        expected = canonical_hash(head_state)
        reread = await device.pull()
        if reread.hash != expected:
            _LOGGER.error("Push '%s' verification failed: device hash differs", meta["name"])
            raise DeviceError("push_verify_failed")
        store.set_sync(rid, baseline=expected, last_push_version=hist.head, last_push_at=time.time())
    _LOGGER.info("Push '%s': v%s sent and verified", meta["name"], hist.head)
    return web.json_response(
        {
            "ok": True,
            "drift_overwritten": drift["status"] == DRIFT_DRIFT,
            "icons_uploaded": uploaded,
            "remote": store.remote_info(rid),
        }
    )


# --------------------------------------------------------------------------
# Handlers - icons (RF7.1-RF7.3)
# --------------------------------------------------------------------------


async def icons_list(request: web.Request) -> web.Response:
    """Library content."""
    return web.json_response(request.app[K_ICONS].list())


async def icon_upload(request: web.Request) -> web.Response:
    """RF7.1: add one or more images (multipart field ``file``) to the library."""
    reader = await request.multipart()
    added = []
    async for part in reader:
        if part.name == "file" and part.filename:
            # Some clients percent-encode the filename in Content-Disposition.
            name = unquote(part.filename)
            added.append(request.app[K_ICONS].add(name, await part.read(decode=False)))
    if not added:
        raise StoreError("bad_request")
    return web.json_response({"added": added}, status=201)


async def icon_get(request: web.Request) -> web.Response:
    """Serve a library icon (editor thumbnails, simulator)."""
    data, ctype = request.app[K_ICONS].read(request.match_info["name"])
    return web.Response(body=data, content_type=ctype, headers={"Cache-Control": "no-cache"})


async def icon_delete(request: web.Request) -> web.Response:
    """RF7.2: delete from the library only."""
    request.app[K_ICONS].delete(request.match_info["name"])
    return web.json_response({"ok": True})


async def remote_icons(request: web.Request) -> web.Response:
    """Icons on one remote (None when unreachable) and in the library."""
    meta = request.app[K_STORE].remote_info(request.match_info["rid"])
    try:
        device = sorted(await _device_icons(request.app, meta, force=True))
    except DeviceError as err:
        _LOGGER.info("Icon list of '%s' unavailable: %s", meta["name"], err.code)
        device = None
    return web.json_response({"device": device, "library": sorted(request.app[K_ICONS].names())})


async def remote_icon_get(request: web.Request) -> web.Response:
    """Proxy an icon stored only on the remote (thumbnails, simulator)."""
    meta = request.app[K_STORE].remote_info(request.match_info["rid"])
    data, ctype = await _device(request.app, meta).icon_get(sanitize(request.match_info["name"]))
    return web.Response(body=data, content_type=ctype or "application/octet-stream")


async def remote_icons_import(request: web.Request) -> web.Response:
    """Copy the remote's icons that are missing from the library into it."""
    meta = request.app[K_STORE].remote_info(request.match_info["rid"])
    device = _device(request.app, meta)
    missing = sorted(await _device_icons(request.app, meta, force=True) - request.app[K_ICONS].names())
    imported, skipped = [], []
    for name in missing:
        data, _ = await device.icon_get(name)
        try:
            imported.append(request.app[K_ICONS].add(name, data))
        except StoreError as err:
            skipped.append({"name": name, "error": err.code})
    _LOGGER.info("Imported %s icon(s) from '%s' (%s skipped)", len(imported), meta["name"], len(skipped))
    return web.json_response({"imported": imported, "skipped": skipped})


# --------------------------------------------------------------------------
# Handlers - simulator (RF6)
# --------------------------------------------------------------------------


async def sim_live(request: web.Request) -> web.WebSocketResponse:
    """RF6.4: forward HA states (snapshot + state_changed) to the simulator."""
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    _LOGGER.debug("Simulator live stream opened")

    async def pump() -> None:
        try:
            async for item in request.app[K_HA].live():
                await ws.send_json(item)
        except HAError as err:
            _LOGGER.warning("Simulator live stream: %s", err)
            await ws.send_json({"type": "error", "error": "ha_unavailable", "detail": str(err)})
        except ConnectionResetError:
            pass

    task = asyncio.create_task(pump())
    try:
        async for _msg in ws:  # the client sends nothing; wait for close
            pass
    finally:
        task.cancel()
        _LOGGER.debug("Simulator live stream closed")
    return ws


async def sim_action(request: web.Request) -> web.Response:
    """RF6.5-RF6.9: execute the steps of one tap / key press for real."""
    rid = request.match_info["rid"]
    data = await _body(request)
    steps = data.get("steps")
    if not isinstance(steps, list) or not steps:
        raise StoreError("bad_request")
    store = request.app[K_STORE]
    meta = store.remote_info(rid)
    # RF6.1: always the head, never a historical version.
    result = await request.app[K_EXEC].run(meta, store.head_state(rid), steps)
    return web.json_response(result)


async def devices_refresh(request: web.Request) -> web.Response:
    """RF8.1: Refresh button - re-read hubs/extenders from the remote."""
    rid = request.match_info["rid"]
    meta = request.app[K_STORE].remote_info(rid)
    cfg = await _device(request.app, meta).devices_config()  # errors -> 502/503
    request.app[K_STORE].set_devices(rid, cfg["harmony_hubs"], cfg["extenders"])
    return web.json_response(request.app[K_STORE].remote_info(rid))


async def sim_active(request: web.Request) -> web.Response:
    """Composed Activities currently active per room (simulator runtime)."""
    rid = request.match_info["rid"]
    request.app[K_STORE].remote_info(rid)
    return web.json_response(request.app[K_EXEC].active.get(rid, {}))


# --------------------------------------------------------------------------
# Application factory
# --------------------------------------------------------------------------


def create_app(data_dir: Path, device_factory=DeviceClient) -> web.Application:
    """Build the aiohttp application."""
    app = web.Application(middlewares=[ingress_only, errors], client_max_size=32 * 1024**2)
    app[K_STORE] = Store(data_dir)
    app[K_LOCKS] = defaultdict(asyncio.Lock)
    app[K_DEVICE] = device_factory
    app[K_HA_OK] = {"ok": True}
    app[K_ICONS] = IconLibrary(data_dir)
    app[K_DEV_ICONS] = {}

    async def _ctx(app: web.Application):
        app[K_HTTP] = aiohttp.ClientSession()
        app[K_HA] = HAClient(app[K_HTTP])
        app[K_HARMONY] = HarmonyRegistry(app[K_HTTP])
        app[K_EXEC] = Executor(app[K_HA], app[K_HARMONY], app[K_DEVICE], app[K_HTTP])
        yield
        await app[K_HARMONY].close()
        await app[K_HTTP].close()

    app.cleanup_ctx.append(_ctx)
    r = app.router
    r.add_get("/", index)
    r.add_static("/static", STATIC)
    r.add_get("/api/meta", meta_info)
    r.add_get("/api/entities", entities)
    r.add_get("/api/icons", icons_list)
    r.add_post("/api/icons", icon_upload)
    r.add_get("/api/icons/{name}", icon_get)
    r.add_delete("/api/icons/{name}", icon_delete)
    r.add_get("/api/remotes/{rid}/icons", remote_icons)
    r.add_get("/api/remotes/{rid}/icons/{name}", remote_icon_get)
    r.add_post("/api/remotes/{rid}/icons/import", remote_icons_import)
    r.add_get("/api/remotes", list_remotes)
    r.add_post("/api/remotes", create_remote)
    r.add_get("/api/drift", drift_all)
    r.add_post("/api/copy", copy_elements)
    r.add_post("/api/validate", validate_state)
    r.add_patch("/api/remotes/{rid}", update_remote)
    r.add_post("/api/remotes/{rid}/archive", archive)
    r.add_post("/api/remotes/{rid}/unarchive", archive)
    r.add_get("/api/remotes/{rid}/state", get_state)
    r.add_get("/api/remotes/{rid}/versions", list_versions)
    r.add_get("/api/remotes/{rid}/versions/{vid}", get_version)
    r.add_put("/api/remotes/{rid}/versions/{vid}/name", set_name)
    r.add_post("/api/remotes/{rid}/commit", commit)
    r.add_post("/api/remotes/{rid}/undo", undo)
    r.add_post("/api/remotes/{rid}/redo", redo)
    r.add_post("/api/remotes/{rid}/restore", restore)
    r.add_get("/api/remotes/{rid}/drift", drift_one)
    r.add_post("/api/remotes/{rid}/pull", pull)
    r.add_post("/api/remotes/{rid}/push", push)
    r.add_get("/api/remotes/{rid}/sim/live", sim_live)
    r.add_post("/api/remotes/{rid}/sim/action", sim_action)
    r.add_get("/api/remotes/{rid}/sim/active", sim_active)
    r.add_post("/api/remotes/{rid}/devices/refresh", devices_refresh)
    return app
