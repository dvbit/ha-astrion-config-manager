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

    def app(self):
        async def get(_):
            if self.text is None:
                return web.Response(status=404, text="No dashboard.json yet")
            return web.Response(text=self.text, content_type="application/json")

        async def post(request):
            data = await request.post()
            self.text = data["file"].file.read().decode("utf-8")
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

        async def devices_config(_):
            if self.devices_cfg is None:
                return web.Response(status=404)
            return web.json_response(self.devices_cfg)

        app = web.Application()
        app.router.add_get("/devices-config", devices_config)
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
    assert drift == [{"id": rid, "status": "drift", "last_push_version": None}]
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
