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

import aiohttp
from aiohttp import web

from . import copying
from .canonical import canonical_hash
from .device import DeviceClient, DeviceError
from .ha import HAClient, HAError
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


async def _validation(app: web.Application, doc: Any) -> dict[str, Any]:
    return validate(doc, await _known_entities(app))


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
        status = {"file_missing": DRIFT_MISSING, "invalid_json": DRIFT_INVALID}.get(
            err.code, DRIFT_UNREACHABLE
        )
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
    return web.json_response(info, status=201)


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
        body["validation"] = await _validation(request.app, state)
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
            "validation": await _validation(request.app, state),
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
        ver = request.app[K_STORE].restore(
            rid, _int(data.get("head")), _int(data.get("version")), _user(request)
        )
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
    return web.json_response(await _validation(request.app, data.get("state")))


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
        # 1. validation (RF4.5)
        check = await _validation(request.app, head_state)
        if not check["push_allowed"]:
            _LOGGER.warning("Push '%s' blocked: %s issue(s)", meta["name"], len(check["issues"]))
            code = "push_blocked" if check["entities_checked"] else "ha_unavailable"
            return web.json_response({"error": code, "validation": check}, status=422)
        # 2. drift check (RF5.2): unreachable blocks, drift is only reported (RF5.3)
        drift = await _drift(request.app, meta)
        if drift["status"] == DRIFT_UNREACHABLE:
            raise DeviceError("unreachable")
        # 3. upload
        device = _device(request.app, meta)
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
            "remote": store.remote_info(rid),
        }
    )


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

    async def _ctx(app: web.Application):
        app[K_HTTP] = aiohttp.ClientSession()
        app[K_HA] = HAClient(app[K_HTTP])
        yield
        await app[K_HTTP].close()

    app.cleanup_ctx.append(_ctx)
    r = app.router
    r.add_get("/", index)
    r.add_static("/static", STATIC)
    r.add_get("/api/meta", meta_info)
    r.add_get("/api/entities", entities)
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
    return app
