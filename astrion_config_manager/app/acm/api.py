"""aiohttp application: Ingress panel + JSON API (spec RF1-RF5, RNF1).

All URLs are relative so the panel works behind the Ingress path prefix.
Business errors are returned as ``{"error": <code>, ...}`` and translated by
the frontend (RNF3).
"""

from __future__ import annotations

import asyncio
import copy
import logging
import os
import re
import time
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import aiohttp
from aiohttp import web

from . import __version__, copying, proxy
from .actions import Executor
from .canonical import canonical_hash, pretty_dumps
from .device import DeviceClient, DeviceError
from .ha import HAClient
from .harmony import HarmonyRegistry
from .icons import IconLibrary, collect_refs, sanitize
from .store import Store, StoreError, clean_fields
from .themes import ThemeLibrary, clean_theme, theme_from_file
from .validate import HARDWARE_KEYS

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
K_THEMES = web.AppKey("themes", ThemeLibrary)
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


def _device(app: web.Application, meta: dict[str, Any]) -> DeviceClient:
    return app[K_DEVICE](app[K_HTTP], meta["host"], meta["port"])


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


async def _refresh_devices(app: web.Application, rid: str) -> None:
    """RF8.1: re-read hubs/extenders from the remote (best effort)."""
    store = app[K_STORE]
    meta = store.remote_info(rid)
    try:
        cfg = await _device(app, meta).devices_config()
    except DeviceError as err:
        _LOGGER.warning("Cannot read hubs/extenders of '%s': %s %s", meta["name"], err.code, err.detail)
        return
    store.set_devices(rid, cfg["harmony_hubs"], cfg["extenders"], cfg["apple_tvs"])
    try:
        store.set_identity(rid, await _device(app, meta).info())  # RF10.9
    except DeviceError as err:
        _LOGGER.info("Identity of '%s' unavailable: %s", meta["name"], err.code)


def _duplicates(remotes: list[dict[str, Any]]) -> None:
    """RF10.9: mark remotes registered twice (same identity id)."""
    by_id: dict[str, list[dict[str, Any]]] = {}
    for r in remotes:
        ident = (r.get("identity") or {}).get("id")
        if ident:
            by_id.setdefault(ident, []).append(r)
    for group in by_id.values():
        for r in group:
            r["duplicate_of"] = [o["name"] for o in group if o is not r]


SETTINGS_PATHS = ("/dock/mode", "/power/screen_timeout_seconds")


# --------------------------------------------------------------------------
# RF12: the remote's own version history (app 1.3.0, DashboardHistory.kt)
# --------------------------------------------------------------------------

# Note sent with every push; also how the add-on recognises its own versions
# in the remote's list (the remote keeps notes up to 200 characters).
PUSH_NOTE_RE = re.compile(r"^ACM v(\d+)\b")
REMOTE_NOTE_MAX = 200


# --------------------------------------------------------------------------
# Handlers - remotes (RF1)
# --------------------------------------------------------------------------


async def index(request: web.Request) -> web.Response:
    """Serve the panel with versioned asset URLs.

    Browsers and the HA companion app cache static files heuristically: after
    an add-on update they kept running the old editor.js. Every asset URL now
    carries ``?v=<version>`` and the page itself is never cached.
    """
    html = (STATIC / "index.html").read_text("utf-8")
    html = re.sub(r'(static/[\w.-]+\.(?:js|css|png))"', rf'\1?v={__version__}"', html)
    html = html.replace("__ACM_VERSION__", __version__)
    return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-store"})


@web.middleware
async def revalidate_static(request: web.Request, handler):
    """Make static files always revalidate with the server (no stale code)."""
    resp = await handler(request)
    if request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


async def meta_info(request: web.Request) -> web.Response:
    """Return the current user and static references for the frontend."""
    return web.json_response({"user": _user(request), "hardware_keys": sorted(HARDWARE_KEYS), "version": __version__})


async def list_remotes(request: web.Request) -> web.Response:
    """RF1.4 / RF5.5: main list or archive view."""
    archived = request.query.get("archived") == "1"
    remotes = request.app[K_STORE].list_remotes(archived)
    _duplicates(remotes)
    return web.json_response(remotes)


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


# --------------------------------------------------------------------------
# Handlers - synchronisation (RF5)
# --------------------------------------------------------------------------


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


async def icon_usage(request: web.Request) -> web.Response:
    """RF10.11: per remote, whether its head uses the icon and whether it holds a copy."""
    name = sanitize(request.match_info["name"])
    store = request.app[K_STORE]
    out = []
    for meta in store.list_remotes(archived=False):
        used = name in collect_refs(store.head_state(meta["id"]))
        try:
            on_remote: bool | None = name in await _device_icons(request.app, meta, force=True)
        except DeviceError:
            on_remote = None
        out.append({"id": meta["id"], "name": meta["name"], "used": used, "on_remote": on_remote})
    return web.json_response(out)


async def icon_delete(request: web.Request) -> web.Response:
    """RF7.2 / RF10.11: delete from the library and, on request, from remotes.

    ``?remotes=id1,id2``: also ``DELETE /icons/<name>`` on those remotes, but
    never on one whose head still references the icon.
    """
    name = sanitize(request.match_info["name"])
    store = request.app[K_STORE]
    results = []
    for rid in [r for r in request.query.get("remotes", "").split(",") if r]:
        meta = store.remote_info(rid)
        if name in collect_refs(store.head_state(rid)):
            results.append({"id": rid, "name": meta["name"], "result": "in_use"})
            continue
        try:
            deleted = await _device(request.app, meta).icon_delete(name)
            results.append({"id": rid, "name": meta["name"], "result": "deleted" if deleted else "absent"})
            request.app[K_DEV_ICONS].pop(rid, None)
            _LOGGER.info("Icon '%s' deleted on '%s'", name, meta["name"])
        except DeviceError as err:
            results.append({"id": rid, "name": meta["name"], "result": err.code})
    if request.query.get("library", "1") == "1" and name in request.app[K_ICONS].names():
        request.app[K_ICONS].delete(name)
    return web.json_response({"ok": True, "remotes": results})


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


async def devices_refresh(request: web.Request) -> web.Response:
    """RF8.1: Refresh button - re-read hubs/extenders from the remote."""
    rid = request.match_info["rid"]
    meta = request.app[K_STORE].remote_info(rid)
    cfg = await _device(request.app, meta).devices_config()  # errors -> 502/503
    request.app[K_STORE].set_devices(rid, cfg["harmony_hubs"], cfg["extenders"], cfg["apple_tvs"])
    return web.json_response(request.app[K_STORE].remote_info(rid))


# Same rule as DashboardHistory.ID_PATTERN.
REMOTE_VID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}(-[0-9]+)?$")


# --------------------------------------------------------------------------
# RF16: built-in weather search, map layout, native builder mode
# --------------------------------------------------------------------------


async def map_layout(request: web.Request) -> web.Response:
    """RF16.3: save the map's screen positions (by page name) for this remote."""
    data = await _body(request)
    layout = request.app[K_STORE].set_map_layout(request.match_info["rid"], data.get("layout"))
    return web.json_response({"layout": layout})


# --------------------------------------------------------------------------
# RF14: shared theme library
# --------------------------------------------------------------------------


async def themes_list(request: web.Request) -> web.Response:
    """Presets + saved themes."""
    return web.json_response(request.app[K_THEMES].list())


async def theme_save(request: web.Request) -> web.Response:
    """RF14.3 Save as (``overwrite`` replaces a saved theme with the same name)."""
    data = await _body(request)
    item = request.app[K_THEMES].save(data.get("name"), data.get("theme"), overwrite=data.get("overwrite") is True)
    return web.json_response(item)


async def theme_rename(request: web.Request) -> web.Response:
    """RF14.4 rename."""
    data = await _body(request)
    return web.json_response(request.app[K_THEMES].rename(request.match_info["tid"], data.get("name")))


async def theme_delete(request: web.Request) -> web.Response:
    """RF14.3 delete (presets are read-only)."""
    request.app[K_THEMES].delete(request.match_info["tid"])
    return web.json_response({"ok": True})


async def theme_export(request: web.Request) -> web.Response:
    """RF14.4 export as ``{"name", "theme"}`` .json."""
    item = request.app[K_THEMES].get(request.match_info["tid"])
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", item["name"]).strip("_") or "theme"
    return web.Response(
        text=pretty_dumps({"name": item["name"], "theme": item["theme"]}),
        content_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="astrion-theme-{slug}.json"'},
    )


async def theme_import(request: web.Request) -> web.Response:
    """RF14.4 import from a file's content: checks colours, reports dropped values.

    Body ``{"data": <parsed file>, "name"?: str}``; a name clash answers 409
    ``theme_name_exists`` so the UI can ask for another name.
    """
    data = await _body(request)
    file_name, raw = theme_from_file(data.get("data"))
    clean, rejected = clean_theme(raw)
    name = data.get("name") or file_name
    item = request.app[K_THEMES].save(name, clean)
    _LOGGER.info("Theme '%s' imported (%s colour(s), %s dropped)", item["name"], len(clean), len(rejected))
    return web.json_response({**item, "rejected": rejected})


def themed(doc: Any, theme: dict[str, Any]) -> Any:
    """RF14.3 Load: the remote's ``theme`` block replaced (empty = remote defaults)."""
    if not isinstance(doc, dict):
        raise StoreError("root_invalid")
    out = copy.deepcopy(doc)
    if theme:
        out["theme"] = copy.deepcopy(theme)
    else:
        out.pop("theme", None)
    return out


async def theme_apply(request: web.Request) -> web.Response:
    """RF14.4 / RF21.6 Apply to remotes: written straight to each remote.

    Body ``{"remotes": [rid, ...]}``; result per remote: ``written``,
    ``unchanged`` or an error code (the remote keeps the version, 1.3.0+).
    """
    data = await _body(request)
    store = request.app[K_STORE]
    item = request.app[K_THEMES].get(request.match_info["tid"])
    results = []
    for rid in data.get("remotes") or []:
        try:
            meta = store.remote_info(rid)
            dev = _device(request.app, meta)
            async with request.app[K_LOCKS][rid]:
                now = await dev.pull()
                new = themed(now.content, item["theme"])
                if canonical_hash(new) == now.hash:
                    results.append({"id": rid, "name": meta["name"], "result": "unchanged"})
                    continue
                await dev.upload(new, f"ACM: theme {item['name']}")
            results.append({"id": rid, "name": meta["name"], "result": "written"})
            _LOGGER.info("Theme '%s' written to '%s'", item["name"], meta["name"])
        except (StoreError, DeviceError) as err:
            _LOGGER.warning("Theme '%s' not applied to %s: %s", item["name"], rid, err.code)
            results.append({"id": rid, "error": err.code})
    return web.json_response({"results": results})


# --------------------------------------------------------------------------
# Handlers - RF21 live document and builder proxy (3.0: no add-on versions)
# --------------------------------------------------------------------------


async def live_get(request: web.Request) -> web.Response:
    """RF21.5: the remote's dashboard.json as it is now, plus its hash and app info."""
    rid = request.match_info["rid"]
    meta = request.app[K_STORE].remote_info(rid)
    dev = _device(request.app, meta)
    pulled = await dev.pull()
    info = await dev.info()
    _LOGGER.debug("Live document of '%s' read (%s)", meta["name"], pulled.hash[:10])
    return web.json_response({"remote": meta, "doc": pulled.content, "hash": pulled.hash, "info": info})


async def live_put(request: web.Request) -> web.Response:
    """RF21.5: write a page-link change straight to the remote.

    Body ``{"doc", "hash", "note"}``. ``hash`` is the hash of the document the
    change was made on: the remote is read again first and, if it changed in
    the meantime (builder, another panel), nothing is written and the current
    document is returned with ``409 remote_changed``.
    """
    rid = request.match_info["rid"]
    data = await _body(request)
    doc, base, note = data.get("doc"), data.get("hash"), str(data.get("note") or "")[:120]
    if not isinstance(doc, dict) or not isinstance(base, str):
        raise StoreError("bad_request")
    meta = request.app[K_STORE].remote_info(rid)
    dev = _device(request.app, meta)
    async with request.app[K_LOCKS][rid]:
        now = await dev.pull()
        if now.hash != base:
            _LOGGER.warning("Not written to '%s': changed on the remote since it was loaded", meta["name"])
            return web.json_response({"error": "remote_changed", "doc": now.content, "hash": now.hash}, status=409)
        vid = await dev.upload(doc, note or None)
        after = await dev.pull()
    _LOGGER.info("Written to '%s': %s (remote version %s)", meta["name"], note or "-", vid or "?")
    return web.json_response({"doc": after.content, "hash": after.hash, "version_id": vid})


async def proxy_any(request: web.Request) -> web.StreamResponse:
    """RF21.1: the remote's own web server (builder) through the panel."""
    meta = request.app[K_STORE].remote_info(request.match_info["rid"])
    return await proxy.forward(request, request.app[K_HTTP], meta["host"], meta["port"], request.match_info["tail"])


# --------------------------------------------------------------------------
# Application factory
# --------------------------------------------------------------------------


def create_app(data_dir: Path, device_factory=DeviceClient) -> web.Application:
    """Build the aiohttp application."""
    app = web.Application(middlewares=[ingress_only, errors, revalidate_static], client_max_size=32 * 1024**2)
    app[K_STORE] = Store(data_dir)
    app[K_LOCKS] = defaultdict(asyncio.Lock)
    app[K_DEVICE] = device_factory
    app[K_HA_OK] = {"ok": True}
    app[K_ICONS] = IconLibrary(data_dir)
    app[K_THEMES] = ThemeLibrary(data_dir)
    app[K_DEV_ICONS] = {}

    async def _ctx(app: web.Application):
        app[K_HTTP] = aiohttp.ClientSession()
        app[K_HA] = HAClient(app[K_HTTP])
        app[K_HARMONY] = HarmonyRegistry(app[K_HTTP])
        app[K_EXEC] = Executor(app[K_HA], app[K_HARMONY], app[K_DEVICE], app[K_HTTP], data_dir)
        yield
        await app[K_HARMONY].close()
        await app[K_HTTP].close()

    app.cleanup_ctx.append(_ctx)
    r = app.router
    r.add_get("/", index)
    r.add_static("/static", STATIC)
    r.add_get("/api/meta", meta_info)
    # RF7 shared icon library (kept)
    r.add_get("/api/icons", icons_list)
    r.add_post("/api/icons", icon_upload)
    r.add_get("/api/icons/{name}", icon_get)
    r.add_delete("/api/icons/{name}", icon_delete)
    r.add_get("/api/icons/{name}/usage", icon_usage)
    r.add_get("/api/remotes/{rid}/icons", remote_icons)
    r.add_get("/api/remotes/{rid}/icons/{name}", remote_icon_get)
    r.add_post("/api/remotes/{rid}/icons/import", remote_icons_import)
    # RF1 remotes registry
    r.add_get("/api/remotes", list_remotes)
    r.add_post("/api/remotes", create_remote)
    r.add_patch("/api/remotes/{rid}", update_remote)
    r.add_post("/api/remotes/{rid}/archive", archive)
    r.add_post("/api/remotes/{rid}/unarchive", archive)
    r.add_post("/api/remotes/{rid}/devices/refresh", devices_refresh)
    # RF21 live document, map layout, builder proxy
    r.add_get("/api/remotes/{rid}/live", live_get)
    r.add_put("/api/remotes/{rid}/live", live_put)
    r.add_put("/api/remotes/{rid}/map-layout", map_layout)
    r.add_route("*", "/proxy/{rid}/{tail:.*}", proxy_any)
    # RF14 theme library (kept; applied by writing to the remotes)
    r.add_get("/api/themes", themes_list)
    r.add_post("/api/themes", theme_save)
    r.add_post("/api/themes/import", theme_import)
    r.add_put("/api/themes/{tid}", theme_rename)
    r.add_delete("/api/themes/{tid}", theme_delete)
    r.add_get("/api/themes/{tid}/export", theme_export)
    r.add_post("/api/themes/{tid}/apply", theme_apply)
    return app
