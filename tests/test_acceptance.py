"""Acceptance tests for v1.0 (spec section 7, criteria 1-6, 10, 11).

A fake Astrion device (same endpoints as upstream ConfigServer.kt) and a fake
HA entity list replace the real network.
"""

from __future__ import annotations

import copy
import json

import pytest
from acm import api as api_mod
from acm.api import K_HA, create_app
from acm.store import SNAPSHOT_EVERY
from aiohttp import web

BASE_DOC = {
    "pages": [
        {
            "name": "Home",
            "cards": [
                {"type": "light", "options": {"entity_id": "light.salotto", "name": "Salotto"}},
                {"type": "future_card", "options": {"magic": [1, 2, {"x": "y"}]}},
            ],
        }
    ],
    "hotkeys": [{"key": "VOLUME_UP", "service": "media_player.volume_up", "entityId": "media_player.tv"}],
    "activities": [
        {
            "id": "tv",
            "room": "salotto",
            "devices": [{"deviceId": "62845789", "source": "harmony"}],
            "harmonyActivity": "99999999",
        }
    ],
}
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
ENTITIES = {"light.salotto", "media_player.tv", "light.cucina"}


class FakeDevice:
    """Emulates GET/POST /dashboard.json of the remote's config page."""

    def __init__(self, doc):
        self.text = json.dumps(doc) if doc is not None else None
        self.uploads = 0
        self.icons = {"onboard.png": PNG}
        self.devices_cfg = None
        self.info = None
        # RF12: emulation of DashboardHistory (app 1.3.0); None = older app (404)
        self.history = None
        self._seq = 0

    def _keep(self, text, reason, note=None, restored_from=None):
        """DashboardHistory.add: newest last here, listed newest first."""
        self._seq += 1
        vid = f"20261017-1000{self._seq:02d}"
        self.history.append(
            {
                "id": vid,
                "time": self._seq,
                "note": note or "",
                "pinned": False,
                "reason": reason,
                "restoredFrom": restored_from or "",
                "size": len(text),
                "pages": 1,
                "cards": 0,
                "text": text,
            }
        )
        return vid

    def record_save(self, new_text, note):
        """DashboardHistory.recordSave: keep the file on disk first when not kept yet."""
        if self.history is None:
            return
        if self.text and (not self.history or json.loads(self.history[-1]["text"]) != json.loads(self.text)):
            self._keep(self.text, "outside")
        self._keep(new_text, "save", note)

    def app(self):
        async def get(_):
            if self.text is None:
                return web.Response(status=404, text="No dashboard.json yet")
            tvs = (self.devices_cfg or {}).get("appleTvs")
            if tvs:  # emulate upstream 1.2.0 reconcileAppleTvHaDevices on read
                from acm.api import reconcile_apple_tvs

                doc = reconcile_apple_tvs(json.loads(self.text), tvs)
                self.text = json.dumps(doc)
            return web.Response(text=self.text, content_type="application/json")

        async def post(request):
            data = await request.post()
            new_text = data["file"].file.read().decode("utf-8")
            self.last_note = data.get("note")
            self.record_save(new_text, self.last_note)
            self.text = new_text
            self.uploads += 1
            raise web.HTTPFound("/")

        async def icons_list(_):
            return web.json_response(sorted(self.icons))

        async def icon_post(request):
            data = await request.post()
            self.icons[data["file"].filename] = data["file"].file.read()
            raise web.HTTPFound("/")

        async def icon_get(request):
            if request.match_info["n"] not in self.icons:
                return web.Response(status=404)
            return web.Response(body=self.icons[request.match_info["n"]], content_type="image/png")

        async def info(_):
            if self.info is None:
                return web.Response(status=404)
            return web.json_response(self.info)

        async def icon_del(request):
            n = request.match_info["n"]
            if n not in self.icons:
                return web.json_response({"error": "No icon"}, status=404)
            del self.icons[n]
            return web.json_response({"status": "ok", "deleted": n})

        async def devices_config(_):
            if self.devices_cfg is None:
                return web.Response(status=404)
            return web.json_response(self.devices_cfg)

        async def hist_list(_):
            if self.history is None:
                return web.Response(status=404)
            keys = ("id", "time", "note", "pinned", "reason", "restoredFrom", "size", "pages", "cards")
            return web.json_response({"versions": [{k: v[k] for k in keys} for v in reversed(self.history)]})

        async def hist_get(request):
            v = next((v for v in self.history or [] if v["id"] == request.match_info["id"]), None)
            if v is None:
                return web.json_response({"error": "no such version"}, status=404)
            return web.Response(text=v["text"], content_type="application/json")

        async def hist_pin(request):
            data = await request.post()
            v = next((v for v in self.history or [] if v["id"] == data.get("id")), None)
            if v is None:
                return web.json_response({"error": "no such version"}, status=404)
            v["pinned"] = data.get("pinned") == "true"
            return web.json_response({"ok": True})

        app = web.Application()
        app.router.add_get("/history", hist_list)
        app.router.add_post("/history/pin", hist_pin)
        app.router.add_get("/history/{id}", hist_get)
        app.router.add_get("/devices-config", devices_config)
        app.router.add_get("/info", info)
        app.router.add_delete("/icons/{n}", icon_del)
        app.router.add_get("/icons-list", icons_list)
        app.router.add_post("/icons", icon_post)
        app.router.add_get("/icons/{n}", icon_get)
        app.router.add_get("/dashboard.json", get)
        app.router.add_post("/dashboard.json", post)

        async def home(_):
            return web.Response(text="home")

        app.router.add_get("/", home)
        return app


class FakeHA:
    async def entity_ids(self, force=False):
        return ENTITIES


@pytest.fixture
async def env(aiohttp_client, aiohttp_server, tmp_path, monkeypatch):
    monkeypatch.setenv("ACM_ALLOW_ANY", "1")
    devices = {"a": FakeDevice(copy.deepcopy(BASE_DOC)), "b": FakeDevice(copy.deepcopy(BASE_DOC))}
    servers = {k: await aiohttp_server(d.app()) for k, d in devices.items()}
    app = create_app(tmp_path)

    async def fake_ha(app):
        app[K_HA] = FakeHA()
        yield

    app.cleanup_ctx.append(fake_ha)
    client = await aiohttp_client(app)
    client.devices, client.servers = devices, servers
    return client


async def register(client, key, name):
    srv = client.servers[key]
    resp = await client.post(
        "/api/remotes",
        json={
            "name": name,
            "host": srv.host,
            "port": srv.port,
            "width": 480,
            "height": 800,
            "orientation": "portrait",
            "harmony_ip": "",
            "ir_entity": "",
        },
    )
    assert resp.status == 201, await resp.text()
    return await resp.json()


async def state(client, rid):
    return await (await client.get(f"/api/remotes/{rid}/state")).json()


async def edit(client, rid, mutate):
    cur = await state(client, rid)
    doc = cur["state"]
    mutate(doc)
    resp = await client.post(f"/api/remotes/{rid}/commit", json={"head": cur["remote"]["head"], "state": doc})
    assert resp.status == 200, await resp.text()
    return await resp.json()


def set_name(value):
    def fn(doc):
        doc["pages"][0]["cards"][0]["options"]["name"] = value

    return fn


async def test_c1_two_remotes_independent(env):
    a = await register(env, "a", "Salotto")
    b = await register(env, "b", "Camera")
    assert a["head"] == 1 and b["head"] == 1
    await edit(env, a["id"], set_name("X"))
    assert (await state(env, a["id"]))["remote"]["head"] == 2
    assert (await state(env, b["id"]))["remote"]["head"] == 1
    # RF1.1 name unique among non archived
    srv = env.servers["a"]
    resp = await env.post(
        "/api/remotes",
        json={
            "name": "salotto",
            "host": srv.host,
            "port": srv.port,
            "width": 1,
            "height": 1,
            "orientation": "portrait",
        },
    )
    assert resp.status == 409


async def test_rf12_failed_pull_does_not_register(env):
    env.devices["a"].text = None
    srv = env.servers["a"]
    resp = await env.post(
        "/api/remotes",
        json={
            "name": "X",
            "host": srv.host,
            "port": srv.port,
            "width": 1,
            "height": 1,
            "orientation": "landscape",
        },
    )
    assert resp.status == 502 and (await resp.json())["error"] == "file_missing"
    assert await (await env.get("/api/remotes")).json() == []


async def test_c2_delta_undo_redo(env):
    rid = (await register(env, "a", "R"))["id"]
    original = (await state(env, rid))["state"]
    v2 = (await edit(env, rid, set_name("A")))["version"]
    assert v2["op_count"] == 1 and v2["type"] == "edit"
    await edit(env, rid, set_name("B"))
    # commit without changes creates nothing (RF2.3)
    same = await edit(env, rid, lambda d: None)
    assert same["version"] is None
    head = 3
    for expected in (4, 5):
        r = await (await env.post(f"/api/remotes/{rid}/undo", json={"head": head})).json()
        assert r["version"]["type"] == "undo" and r["version"]["id"] == expected
        head = expected
    assert r["state"] == original
    r = await (await env.post(f"/api/remotes/{rid}/redo", json={"head": head})).json()
    assert r["version"]["type"] == "redo"
    assert r["state"]["pages"][0]["cards"][0]["options"]["name"] == "A"
    assert r["remote"]["can_redo"] is True
    r = await edit(env, rid, set_name("C"))
    assert r["remote"]["can_redo"] is False


async def test_rf210_stale_head_rejected(env):
    rid = (await register(env, "a", "R"))["id"]
    await edit(env, rid, set_name("A"))
    resp = await env.post(f"/api/remotes/{rid}/commit", json={"head": 1, "state": BASE_DOC})
    assert resp.status == 409 and (await resp.json())["head"] == 2


async def test_c3_restore(env):
    rid = (await register(env, "a", "R"))["id"]
    for i in range(7):
        await edit(env, rid, set_name(f"n{i}"))
    v3 = (await (await env.get(f"/api/remotes/{rid}/state?version=3")).json())["state"]
    r = await (await env.post(f"/api/remotes/{rid}/restore", json={"head": 8, "version": 3})).json()
    assert r["version"]["id"] == 9 and r["version"]["type"] == "restore" and r["state"] == v3
    hist = await (await env.get(f"/api/remotes/{rid}/versions")).json()
    assert [v["id"] for v in hist["versions"]] == list(range(9, 0, -1))


async def test_c4_unknown_card_roundtrip(env):
    rid = (await register(env, "a", "R"))["id"]
    await edit(env, rid, set_name("pushed"))
    resp = await env.post(f"/api/remotes/{rid}/push", json={"head": 2})
    assert resp.status == 200, await resp.text()
    on_device = json.loads(env.devices["a"].text)
    assert on_device["pages"][0]["cards"][1] == BASE_DOC["pages"][0]["cards"][1]
    assert (await resp.json())["remote"]["last_push_version"] == 2


async def test_c5_drift_detected_no_action(env):
    rid = (await register(env, "a", "R"))["id"]
    doc = json.loads(env.devices["a"].text)
    doc["pages"][0]["name"] = "Edited online"
    env.devices["a"].text = json.dumps(doc)
    drift = await (await env.get("/api/drift")).json()
    assert drift == [
        {
            "id": rid,
            "status": "drift",
            "last_push_version": None,
            "changes": {"paths": ["/pages/0/name"], "count": 1, "settings_only": False, "remote_last": None},
        }
    ]
    assert (await state(env, rid))["remote"]["head"] == 1  # nothing automatic
    # import as version -> sync-import, baseline updated
    r = await (await env.post(f"/api/remotes/{rid}/pull", json={"head": 1})).json()
    assert r["version"]["type"] == "sync-import"
    assert (await (await env.get("/api/drift")).json())[0]["status"] == "in_sync"


async def test_c6_missing_entity_blocks_push(env):
    rid = (await register(env, "a", "R"))["id"]
    await edit(env, rid, lambda d: d["pages"][0]["cards"][0]["options"].update(entity_id="light.ghost"))
    resp = await env.post(f"/api/remotes/{rid}/push", json={"head": 2})
    body = await resp.json()
    assert resp.status == 422 and body["error"] == "push_blocked"
    assert body["validation"]["issues"][0]["code"] == "entity_missing"
    assert env.devices["a"].uploads == 0
    # Non-existent Harmony activity is only checked structurally: push allowed (RF4.3)
    await edit(env, rid, lambda d: d["pages"][0]["cards"][0]["options"].update(entity_id="light.cucina"))
    resp = await env.post(f"/api/remotes/{rid}/push", json={"head": 3})
    assert resp.status == 200


async def test_push_unreachable(env, monkeypatch):
    rid = (await register(env, "a", "R"))["id"]
    await env.patch(f"/api/remotes/{rid}", json={"port": 1})
    resp = await env.post(f"/api/remotes/{rid}/push", json={"head": 1})
    assert resp.status == 503


async def test_c10_archive(env):
    rid = (await register(env, "a", "R"))["id"]
    await edit(env, rid, set_name("A"))
    await env.post(f"/api/remotes/{rid}/archive")
    assert await (await env.get("/api/remotes")).json() == []
    arch = await (await env.get("/api/remotes?archived=1")).json()
    assert arch[0]["id"] == rid and arch[0]["head"] == 2
    await env.post(f"/api/remotes/{rid}/unarchive")
    assert len(await (await env.get("/api/remotes")).json()) == 1


async def test_c11_named_versions(env):
    rid = (await register(env, "a", "R"))["id"]
    for i in range(7):
        await edit(env, rid, set_name(f"n{i}"))
    resp = await env.put(f"/api/remotes/{rid}/versions/3/name", json={"name": "A"})
    assert resp.status == 200
    assert (await state(env, rid))["remote"]["head"] == 8  # naming creates no version
    resp = await env.put(f"/api/remotes/{rid}/versions/5/name", json={"name": "a"})
    assert resp.status == 409
    await edit(env, rid, set_name("later"))
    v3 = (await (await env.get(f"/api/remotes/{rid}/state?version=3")).json())["state"]
    r = await (await env.post(f"/api/remotes/{rid}/restore", json={"head": 9, "version": 3})).json()
    assert r["state"] == v3 and r["version"]["type"] == "restore"
    hist = await (await env.get(f"/api/remotes/{rid}/versions")).json()
    assert [v["name"] for v in hist["versions"] if v["name"]] == ["A"]


async def test_rf28_snapshots_and_reload(env, tmp_path):
    rid = (await register(env, "a", "R"))["id"]
    for i in range(SNAPSHOT_EVERY + 5):
        await edit(env, rid, set_name(f"n{i}"))
    snaps = sorted(p.name for p in (tmp_path / "remotes" / rid / "snapshots").iterdir())
    assert snaps == ["00000001.json.gz", "00000050.json.gz"]
    head = (await state(env, rid))["state"]
    # A fresh store rebuilds the same head from disk (RNF2).
    from acm.store import Store

    store = Store(tmp_path)
    assert store.head_state(rid) == head
    assert store.history(rid).state(52)["pages"][0]["cards"][0]["options"]["name"] == "n50"


async def test_rf33_copy_pages(env):
    a = (await register(env, "a", "A"))["id"]
    b = (await register(env, "b", "B"))["id"]
    await edit(
        env,
        a,
        lambda d: d.update(irDevices=[{"id": "tv", "commands": {"on": {"freq": 38000, "pattern": [1, 2]}}}]),
    )
    await edit(
        env,
        a,
        lambda d: d["pages"].append(
            {
                "name": "Sub",
                "linkedPage": "Home",
                "cards": [{"type": "button_grid", "options": {"buttons": [{"irDevice": "tv", "irCommand": "on"}]}}],
            }
        ),
    )
    await edit(
        env,
        b,
        lambda d: d.update(irDevices=[{"id": "tv", "commands": {"off": {"freq": 38000, "pattern": [3]}}}]),
    )
    resp = await env.post("/api/copy", json={"src": a, "dst": b, "kind": "pages", "pages": [0, 1], "head": 2})
    body = await resp.json()
    assert resp.status == 200, body
    pages = body["state"]["pages"]
    assert [p["name"] for p in pages] == ["Home", "Home 2", "Sub"]
    assert pages[2]["linkedPage"] == "Home 2"
    assert pages[2]["cards"][0]["options"]["buttons"][0]["irDevice"] == "tv_2"
    assert body["version"]["id"] == 3  # one single version


async def test_ingress_only(aiohttp_client, tmp_path, monkeypatch):
    monkeypatch.delenv("ACM_ALLOW_ANY", raising=False)
    client = await aiohttp_client(create_app(tmp_path))
    assert (await client.get("/api/remotes")).status == 403
    assert api_mod.INGRESS_IP == "172.30.32.2"


# ---------------------------------------------------------------- RF7


async def test_rf7_icon_library_and_push_upload(env):
    rid = (await register(env, "a", "R"))["id"]
    form = __import__("aiohttp").FormData()
    form.add_field("file", PNG, filename="my disco.png", content_type="image/png")
    resp = await env.post("/api/icons", data=form)
    assert (await resp.json())["added"] == ["my_disco.png"]  # upstream sanitize()
    bad = __import__("aiohttp").FormData()
    bad.add_field("file", b"not an image", filename="x.png")
    assert (await (await env.post("/api/icons", data=bad)).json())["error"] == "icon_format_invalid"

    def use(path):
        def fn(d):
            d["pages"][0]["cards"].append(
                {"type": "button_grid", "options": {"buttons": [{"name": "D", "icon": path}]}}
            )

        return fn

    # icon only in library -> valid; push uploads it to the remote
    r = await edit(env, rid, use("/sdcard/astrion/icons/my_disco.png"))
    assert r["validation"]["issues"] == []
    resp = await env.post(f"/api/remotes/{rid}/push", json={"head": 2})
    body = await resp.json()
    assert resp.status == 200 and body["icons_uploaded"] == ["my_disco.png"]
    assert "my_disco.png" in env.devices["a"].icons
    # icon only on the remote -> valid; icon nowhere -> error blocks push
    r = await edit(env, rid, use("/sdcard/astrion/icons/onboard.png"))
    assert r["validation"]["issues"] == []
    r = await edit(env, rid, use("/sdcard/astrion/icons/ghost.png"))
    assert [i["code"] for i in r["validation"]["issues"]] == ["icon_missing"]
    resp = await env.post(f"/api/remotes/{rid}/push", json={"head": 4})
    assert resp.status == 422
    # delete from library only; import from remote
    assert (await env.delete("/api/icons/my_disco.png")).status == 200
    res = await (await env.post(f"/api/remotes/{rid}/icons/import")).json()
    assert sorted(res["imported"]) == ["my_disco.png", "onboard.png"]
    lst = await (await env.get(f"/api/remotes/{rid}/icons")).json()
    assert "onboard.png" in lst["device"] and "onboard.png" in lst["library"]


async def test_rf7_ha_device_catalog(env):
    rid = (await register(env, "a", "R"))["id"]
    cat = [{"id": "luce", "domain": "light", "entityId": "light.salotto", "name": "Luce"}]
    r = await edit(env, rid, lambda d: d.update(haDevices=cat))
    assert r["validation"]["issues"] == []
    bad = [
        {"id": "x", "domain": "light", "entityId": "switch.a", "name": "X"},
        {"id": "x", "domain": "select", "entityId": "input_select.ghost", "name": "Y"},
    ]
    r = await edit(env, rid, lambda d: d.update(haDevices=bad))
    codes = sorted(i["code"] for i in r["validation"]["issues"])
    assert codes == ["duplicate_id", "entity_missing", "entity_missing", "ha_device_domain"]


async def test_rf7_copy_brings_catalog(env):
    a = (await register(env, "a", "A"))["id"]
    b = (await register(env, "b", "B"))["id"]
    await edit(
        env,
        a,
        lambda d: d.update(
            haDevices=[
                {"id": "luce", "domain": "light", "entityId": "light.salotto", "name": "Luce"},
                {"id": "unused", "domain": "light", "entityId": "light.cucina", "name": "Cucina"},
            ]
        ),
    )
    await edit(
        env,
        b,
        lambda d: d.update(haDevices=[{"id": "luce", "domain": "light", "entityId": "light.cucina", "name": "Altro"}]),
    )
    resp = await env.post(
        "/api/copy", json={"src": a, "dst": b, "kind": "cards", "src_page": 0, "cards": [0], "dst_page": 0, "head": 2}
    )
    body = await resp.json()
    assert [(d["id"], d["entityId"]) for d in body["state"]["haDevices"]] == [
        ("luce", "light.cucina"),
        ("luce_2", "light.salotto"),
    ]


async def test_rf8_devices_config_read_without_token(env, tmp_path):
    secret = "SECRET-TOKEN-123"
    cfg = {
        "ha": {"url": "http://ha:8123", "token": secret, "webhookId": ""},
        "harmonyHubs": [{"localId": "h1", "name": "Salotto", "ip": "10.0.0.5", "hubId": "42"}],
        "extenders": [{"localId": "x1", "name": "Ext", "host": "10.0.0.9", "mac": "aa"}],
    }
    env.devices["a"].devices_cfg = cfg
    info = await register(env, "a", "R")
    assert info["harmony_hubs"] == [{"localId": "h1", "name": "Salotto", "ip": "10.0.0.5", "hubId": "42"}]
    assert info["extenders"] == [{"localId": "x1", "name": "Ext", "host": "10.0.0.9"}]
    for f in tmp_path.rglob("*"):
        if f.is_file():
            assert secret.encode() not in f.read_bytes(), f
    rid = info["id"]
    r = await edit(
        env,
        rid,
        lambda d: d.update(
            irDevices=[
                {"id": "a", "target": {"extender": "x1"}, "commands": {"on": {"freq": 38000, "pattern": [1]}}},
                {"id": "b", "target": {"extender": "zz"}, "commands": {"on": {"freq": 38000, "pattern": [1]}}},
            ],
            hotkeys=[{"key": "MAIN", "harmonyActivity": "1", "hub": "ghost"}],
        ),
    )
    v = r["validation"]
    assert [i["code"] for i in v["issues"]] == ["ir_extender_unknown"]
    assert [w["code"] for w in v["warnings"]] == ["hub_unknown"]


async def test_rf35_fixed_values_and_colors_warn(env):
    rid = (await register(env, "a", "R"))["id"]

    def mutate(d):
        title = {"title": "T", "alignment": "middle", "color": "red"}
        d["pages"][0]["cards"].append({"type": "title", "options": title})
        d["pages"][0]["cards"].append({"type": "camera", "options": {"entity_id": "light.salotto", "aspect": 2.35}})
        d["theme"] = {"accent": "#FF6EA8FE", "background": "blue"}

    v = (await edit(env, rid, mutate))["validation"]
    assert v["issues"] == []  # warnings only: push not blocked
    assert sorted(w["code"] + w["path"] for w in v["warnings"]) == [
        "color_invalid/pages/0/cards/2/options/color",
        "color_invalid/theme/background",
        "value_unexpected/pages/0/cards/2/options/alignment",
    ]


async def test_index_versioned_assets(env):
    from acm import __version__

    resp = await env.get("/")
    html = await resp.text()
    assert resp.headers["Cache-Control"] == "no-store"
    assert f'static/editor.js?v={__version__}"' in html and "__ACM_VERSION__" not in html
    resp = await env.get(f"/static/editor.js?v={__version__}")
    assert resp.status == 200 and resp.headers["Cache-Control"] == "no-cache"


# ---------------------------------------------------------------- RF9 (upstream 1.2.0)


async def test_rf9_apple_tv_direct(env, tmp_path):
    cred = "ltpk:ltsk:atv:client-SECRET"
    tv = {
        "localId": "salon",
        "name": "Apple TV Salon",
        "entityId": "media_player.appletv_salon",
        "host": "10.0.0.7",
        "port": 49153,
        "credentials": cred,
    }
    env.devices["a"].devices_cfg = {"harmonyHubs": [], "extenders": [], "appleTvs": [tv]}
    info = await register(env, "a", "R")
    assert info["apple_tvs"] == [
        {"localId": "salon", "name": "Apple TV Salon", "entityId": "media_player.appletv_salon"}
    ]
    for f in tmp_path.rglob("*"):
        if f.is_file():
            assert b"SECRET" not in f.read_bytes(), f
    rid = info["id"]
    # the remote-only entity is valid; both ways set -> warning only
    card = {"type": "apple_tv_remote", "options": {"appleTv": "media_player.appletv_salon", "deviceId": "123"}}
    r = await edit(env, rid, lambda d: d["pages"][0]["cards"].append(card))
    assert r["validation"]["issues"] == []
    assert [w["code"] for w in r["validation"]["warnings"]] == ["appletv_both"]
    # v1 import already contains the catalog entry (remote reconciled on read)
    head = r["remote"]["head"]
    resp = await env.post(f"/api/remotes/{rid}/push", json={"head": head})
    assert resp.status == 200, await resp.text()
    # rename on the remote -> push adds a sync-import version first, then verifies
    tv["name"] = "Apple TV Living"
    resp = await env.post(f"/api/remotes/{rid}/push", json={"head": head})
    body = await resp.json()
    assert resp.status == 200, body
    assert body["remote"]["head"] == head + 1
    hist = await (await env.get(f"/api/remotes/{rid}/versions")).json()
    assert hist["versions"][0]["type"] == "sync-import"
    st = (await state(env, rid))["state"]
    assert {
        "id": "appletv_salon",
        "domain": "media_player",
        "entityId": "media_player.appletv_salon",
        "name": "Apple TV Living",
    } in st["haDevices"]


async def test_monitor_rows_must_be_objects(env):
    rid = (await register(env, "a", "R"))["id"]
    card = {
        "type": "monitor",
        "options": {"title": "S", "entities": ["light.salotto", {"entity_id": "light.cucina", "name": "C"}]},
    }
    v = (await edit(env, rid, lambda d: d["pages"][0]["cards"].append(card)))["validation"]
    assert [(w["code"], w["path"]) for w in v["warnings"]] == [
        ("item_not_object", "/pages/0/cards/2/options/entities/0")
    ]
    assert v["issues"] == []


# ---------------------------------------------------------------- 1.2.1-beta


async def test_long_press_and_media_controls(env):
    rid = (await register(env, "a", "R"))["id"]
    grid = {
        "type": "button_grid",
        "options": {
            "buttons": [
                {
                    "name": "Ok",
                    "service": "light.toggle",
                    "entity_id": "light.salotto",
                    "long_press": {"service": "light.turn_off", "entity_id": "light.ghost", "page": "Home"},
                },
                {"name": "Bad", "long_press": "nope"},
            ]
        },
    }
    media = {
        "type": "media_player",
        "options": {"entity_id": "media_player.tv", "media_controls": "previous,stop", "volume_controls": ""},
    }
    v = (await edit(env, rid, lambda d: d["pages"][0]["cards"].extend([grid, media])))["validation"]
    # entities inside long_press are validated like the tile's own
    assert [(i["code"], i["path"]) for i in v["issues"]] == [
        ("entity_missing", "/pages/0/cards/2/options/buttons/0/long_press/entity_id")
    ]
    assert sorted((w["code"], w["path"]) for w in v["warnings"]) == [
        ("type_mismatch", "/pages/0/cards/2/options/buttons/1/long_press"),
        ("value_unexpected", "/pages/0/cards/3/options/media_controls"),
    ]


async def test_copy_rewrites_page_in_long_press(env):
    a = (await register(env, "a", "A"))["id"]
    b = (await register(env, "b", "B"))["id"]
    tile = {"name": "T", "long_press": {"page": "Home", "irDevice": "tv", "irCommand": "on"}}
    await edit(
        env,
        a,
        lambda d: (
            d.update(irDevices=[{"id": "tv", "commands": {"on": {"freq": 38000, "pattern": [1, 2]}}}]),
            d["pages"][0]["cards"].append({"type": "scene_grid", "options": {"scenes": [tile]}}),
        ),
    )
    await edit(
        env, b, lambda d: d.update(irDevices=[{"id": "tv", "commands": {"off": {"freq": 38000, "pattern": [3]}}}])
    )
    body = await (
        await env.post("/api/copy", json={"src": a, "dst": b, "kind": "pages", "pages": [0], "head": 2})
    ).json()
    lp = body["state"]["pages"][-1]["cards"][-1]["options"]["scenes"][0]["long_press"]
    assert lp["page"] == "Home 2" and lp["irDevice"] == "tv_2"


# ---------------------------------------------------------------- RF10 (1.2.7-beta)


async def test_rf10_identity_and_duplicates(env):
    ident = {"id": "astrion-1234", "name": "Living room", "model": "HA100", "version": "1.2.7-beta", "webhook": True}
    env.devices["a"].devices_cfg = {"harmonyHubs": [], "extenders": [], "appleTvs": []}
    env.devices["a"].info = ident
    a = await register(env, "a", "One")
    assert a["identity"]["id"] == "astrion-1234" and a["identity"]["version"] == "1.2.7-beta"
    # same physical remote registered again under another name -> both flagged
    srv = env.servers["a"]
    resp = await env.post(
        "/api/remotes",
        json={"name": "Two", "host": srv.host, "port": srv.port, "width": 1, "height": 1, "orientation": "portrait"},
    )
    assert resp.status == 201
    listed = await (await env.get("/api/remotes")).json()
    assert sorted(r["duplicate_of"] for r in listed) == [["One"], ["Two"]]


async def test_rf10_icon_delete_on_remotes(env):
    a = (await register(env, "a", "A"))["id"]
    b = (await register(env, "b", "B"))["id"]
    form = __import__("aiohttp").FormData()
    form.add_field("file", PNG, filename="x.png", content_type="image/png")
    await env.post("/api/icons", data=form)
    env.devices["a"].icons["x.png"] = PNG
    env.devices["b"].icons["x.png"] = PNG
    # remote B uses it -> never deleted there
    card = {"type": "button_grid", "options": {"buttons": [{"name": "X", "icon": "/sdcard/astrion/icons/x.png"}]}}
    await edit(env, b, lambda d: d["pages"][0]["cards"].append(card))
    usage = {u["name"]: u for u in await (await env.get("/api/icons/x.png/usage")).json()}
    assert usage["A"] == {"id": a, "name": "A", "used": False, "on_remote": True}
    assert usage["B"]["used"] is True
    res = await (await env.delete(f"/api/icons/x.png?remotes={a},{b}")).json()
    assert {r["name"]: r["result"] for r in res["remotes"]} == {"A": "deleted", "B": "in_use"}
    assert "x.png" not in env.devices["a"].icons and "x.png" in env.devices["b"].icons
    assert all(i["name"] != "x.png" for i in await (await env.get("/api/icons")).json())


async def test_rf10_drift_from_remote_settings(env):
    rid = (await register(env, "a", "R"))["id"]
    doc = json.loads(env.devices["a"].text)
    doc["dock"] = {"mode": "clock"}
    env.devices["a"].text = json.dumps(doc)
    drift = await (await env.get(f"/api/remotes/{rid}/drift")).json()
    assert drift["status"] == "drift" and drift["changes"]["settings_only"] is True


# ------------------------------------------------------------- RF12 remote history (app 1.3.0)


async def test_rf12_push_note_pin_and_history_panel(env):
    dev = env.devices["a"]
    dev.history = []
    rid = (await register(env, "a", "R"))["id"]
    # name v1, enable pinning of named versions, push
    await env.put(f"/api/remotes/{rid}/versions/1/name", json={"name": "Baseline"})
    await env.patch(f"/api/remotes/{rid}", json={"pin_named": True})
    res = await (await env.post(f"/api/remotes/{rid}/push", json={"head": 1})).json()
    assert dev.last_note == 'ACM v1 · "Baseline"'
    assert res["remote_pinned"] == dev.history[-1]["id"] and dev.history[-1]["pinned"] is True
    hist = await (await env.get(f"/api/remotes/{rid}/remote-history")).json()
    assert hist["supported"] is True
    assert hist["versions"][0]["addon_version"] == 1 and hist["versions"][0]["reason"] == "save"
    # the file on disk before the first save was kept as "outside" (not from the add-on)
    assert hist["versions"][-1]["reason"] == "outside" and hist["versions"][-1]["addon_version"] is None


async def test_rf12_drift_reason_diff_and_import(env):
    dev = env.devices["a"]
    dev.history = []
    rid = (await register(env, "a", "R"))["id"]
    await env.post(f"/api/remotes/{rid}/push", json={"head": 1})
    # the builder saves a change on the remote with a note
    doc = json.loads(dev.text)
    doc["pages"][0]["name"] = "From builder"
    new_text = json.dumps(doc)
    dev.record_save(new_text, "new lights")
    dev.text = new_text
    drift = await (await env.get(f"/api/remotes/{rid}/drift")).json()
    last = drift["changes"]["remote_last"]
    assert last["reason"] == "save" and last["note"] == "new lights" and last["addon_version"] is None
    vid = last["id"]
    diff = await (await env.get(f"/api/remotes/{rid}/remote-history/{vid}/diff")).json()
    assert diff == {"paths": ["/pages/0/name"], "count": 1}
    down = await env.get(f"/api/remotes/{rid}/remote-history/{vid}")
    assert "attachment" in down.headers["Content-Disposition"]
    head = (await state(env, rid))["remote"]["head"]
    res = await (await env.post(f"/api/remotes/{rid}/remote-history/{vid}/import", json={"head": head})).json()
    assert res["version"]["type"] == "sync-import"
    assert res["version"]["origin"] == {"remote_version": vid, "note": "new lights", "reason": "save"}
    assert res["state"]["pages"][0]["name"] == "From builder"
    # it was the remote's current file: in sync again, as after a pull
    assert (await (await env.get(f"/api/remotes/{rid}/drift")).json())["status"] == "in_sync"
    bad = await env.get(f"/api/remotes/{rid}/remote-history/..%2Fx")
    assert bad.status in (400, 404)


async def test_rf12_older_app_without_history(env):
    rid = (await register(env, "a", "R"))["id"]
    hist = await (await env.get(f"/api/remotes/{rid}/remote-history")).json()
    assert hist == {"supported": False, "versions": []}
    res = await (await env.post(f"/api/remotes/{rid}/push", json={"head": 1})).json()
    assert res["ok"] is True and res["remote_pinned"] is None


# ------------------------------------------------------------- RF14 theme library


async def test_rf14_presets_save_rename_delete(env):
    lst = await (await env.get("/api/themes")).json()
    assert [t["name"] for t in lst[:4]] == ["Default", "Light", "OLED black", "High contrast"]
    assert all(t["preset"] for t in lst[:4]) and lst[0]["theme"] == {}
    res = await env.post(
        "/api/themes", json={"name": "Salon", "theme": {"accent": "#FF0000", "bogus": "#000", "danger": "red"}}
    )
    item = await res.json()
    assert item["theme"] == {"accent": "#FF0000"}
    assert {r["key"] for r in item["rejected"]} == {"bogus", "danger"}
    # names are unique, case-insensitive, presets included
    dup = await env.post("/api/themes", json={"name": "salon", "theme": {}})
    assert dup.status == 409 and (await dup.json())["error"] == "theme_name_exists"
    clash = await env.post("/api/themes", json={"name": "light", "theme": {}, "overwrite": True})
    assert clash.status == 409  # a preset is never overwritten
    over = await (
        await env.post("/api/themes", json={"name": "SALON", "theme": {"accent": "#00FF00"}, "overwrite": True})
    ).json()
    assert over["id"] == item["id"] and over["theme"] == {"accent": "#00FF00"} and over["name"] == "Salon"
    ren = await (await env.put(f"/api/themes/{item['id']}", json={"name": "Living"})).json()
    assert ren["name"] == "Living"
    assert (await env.delete("/api/themes/preset:light")).status == 403
    assert (await env.delete(f"/api/themes/{item['id']}")).status == 200
    assert len(await (await env.get("/api/themes")).json()) == 4


async def test_rf14_export_import_and_apply(env):
    rid_a = (await register(env, "a", "A"))["id"]
    rid_b = (await register(env, "b", "B"))["id"]
    exp = await env.get("/api/themes/preset:oled/export")
    assert "attachment" in exp.headers["Content-Disposition"]
    data = json.loads(await exp.text())
    imp = await env.post("/api/themes/import", json={"data": data})
    assert imp.status == 409  # same name as the preset: the UI asks for another one
    item = await (await env.post("/api/themes/import", json={"data": data, "name": "My OLED"})).json()
    assert item["theme"]["background"] == "#000000" and item["rejected"] == []
    # a whole dashboard.json is accepted too (its theme block)
    dash = {"pages": [], "theme": {"accent": "#123456", "primaryText": "nope"}}
    item2 = await (await env.post("/api/themes/import", json={"data": dash, "name": "From dash"})).json()
    assert item2["theme"] == {"accent": "#123456"} and item2["rejected"][0]["key"] == "primaryText"
    res = await (await env.post(f"/api/themes/{item['id']}/apply", json={"remotes": [rid_a, rid_b, "nope"]})).json()
    by = {r["id"]: r for r in res["results"]}
    assert by[rid_a]["version"] == 2 and by[rid_b]["version"] == 2 and by["nope"]["error"]
    st = await state(env, rid_a)
    assert st["state"]["theme"]["background"] == "#000000"
    # Default preset = remote built-ins: the theme block is removed (one more version)
    res = await (await env.post("/api/themes/preset:default/apply", json={"remotes": [rid_a]})).json()
    assert res["results"][0]["version"] == 3 and "theme" not in (await state(env, rid_a))["state"]
    again = await (await env.post("/api/themes/preset:default/apply", json={"remotes": [rid_a]})).json()
    assert again["results"][0]["version"] is None  # unchanged: no version


# ------------------------------------------------------------- RF16 (upstream 1.3.1-1.3.2-beta, native builder mode)


async def test_rf16_push_version_header_pins_directly(env, monkeypatch):
    dev = env.devices["a"]
    dev.history = []
    rid = (await register(env, "a", "R"))["id"]
    await env.put(f"/api/remotes/{rid}/versions/1/name", json={"name": "Base"})
    await env.patch(f"/api/remotes/{rid}", json={"pin_named": True})
    # emulate 1.3.1: the push reply carries X-Astrion-Version-Id; /history listing is then not needed
    from acm import device as devmod

    orig = devmod.DeviceClient.upload

    async def upload(self, content, note=None):
        await orig(self, content, note)
        return dev.history[-1]["id"]

    monkeypatch.setattr(devmod.DeviceClient, "upload", upload)
    res = await (await env.post(f"/api/remotes/{rid}/push", json={"head": 1})).json()
    assert res["remote_version"] == dev.history[-1]["id"] and res["remote_pinned"] == res["remote_version"]
    assert dev.history[-1]["pinned"] is True
    assert (await state(env, rid))["remote"]["last_push_remote_version"] == res["remote_version"]


async def test_rf16_weather_block_and_entity():
    from acm.validate import validate

    base = {"pages": [{"name": "A", "cards": [{"type": "clock_weather", "options": {"entity_id": "weather.astrion"}}]}]}
    res = validate(base, set())
    assert any(i["code"] == "entity_missing" for i in res["issues"])  # no weather block: not published
    ok = {**base, "weather": {"name": "Roma", "latitude": 41.9, "longitude": 12.5, "model": "auto", "unit": "celsius"}}
    assert validate(ok, set())["push_allowed"] is True
    bad = {**base, "weather": {"latitude": 100, "model": "gfs", "unit": "kelvin"}}
    res = validate(bad, set())
    codes = {(w["path"], w["code"]) for w in res["warnings"]}
    assert {
        ("/weather/latitude", "value_range"),
        ("/weather/longitude", "weather_coord_required"),
        ("/weather/model", "value_unexpected"),
        ("/weather/unit", "value_unexpected"),
    } <= codes
    assert any(i["code"] == "entity_missing" for i in res["issues"])  # unusable block: entity not published


async def test_rf16_map_layout_and_native_flow(env):
    dev = env.devices["a"]
    dev.history = []
    rid = (await register(env, "a", "R"))["id"]
    lay = await (
        await env.put(f"/api/remotes/{rid}/map-layout", json={"layout": {"Home": {"x": 10, "y": -5.25}, "bad": 3}})
    ).json()
    assert lay["layout"] == {"Home": {"x": 10.0, "y": -5.2}}
    assert (await state(env, rid))["remote"]["map_layout"] == lay["layout"]
    await env.patch(f"/api/remotes/{rid}", json={"native_builder": True})
    assert (await state(env, rid))["remote"]["native_builder"] is True
    # nothing changed anywhere
    assert (await (await env.get(f"/api/remotes/{rid}/native")).json())["unsynced"] is False
    r = await (await env.post(f"/api/remotes/{rid}/native/return", json={"head": 1})).json()
    assert r["status"] == "unchanged"
    # add-on edit -> unsynced -> discard = restore of the synced version
    st = await state(env, rid)
    doc = st["state"]
    doc["pages"][0]["name"] = "Local edit"
    await env.post(f"/api/remotes/{rid}/commit", json={"head": 1, "state": doc})
    assert (await (await env.get(f"/api/remotes/{rid}/native")).json())["unsynced"] is True
    r = await (await env.post(f"/api/remotes/{rid}/native/discard", json={"head": 2})).json()
    assert r["version"]["type"] == "restore" and r["version"]["ref"] == 1
    assert (await (await env.get(f"/api/remotes/{rid}/native")).json())["unsynced"] is False
    # the builder saves on the remote -> imported with the remote's note
    remote_doc = json.loads(dev.text)
    remote_doc["pages"][0]["name"] = "From builder"
    new_text = json.dumps(remote_doc)
    dev.record_save(new_text, "renamed page")
    dev.text = new_text
    r = await (await env.post(f"/api/remotes/{rid}/native/return", json={"head": 3})).json()
    assert r["status"] == "imported" and r["version"]["origin"]["note"] == "renamed page"
    assert r["state"]["pages"][0]["name"] == "From builder"
    assert (await (await env.get(f"/api/remotes/{rid}/drift")).json())["status"] == "in_sync"
    # both sides changed -> conflict, nothing imported
    head = r["remote"]["head"]
    doc = r["state"]
    doc["pages"][0]["name"] = "Add-on side"
    await env.post(f"/api/remotes/{rid}/commit", json={"head": head, "state": doc})
    remote_doc["pages"][0]["name"] = "Remote side"
    dev.text = json.dumps(remote_doc)
    r = await (await env.post(f"/api/remotes/{rid}/native/return", json={"head": head + 1})).json()
    assert r["status"] == "conflict"
    assert (await state(env, rid))["state"]["pages"][0]["name"] == "Add-on side"
