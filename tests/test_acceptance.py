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


async def test_ingress_only(aiohttp_client, tmp_path, monkeypatch):
    monkeypatch.delenv("ACM_ALLOW_ANY", raising=False)
    client = await aiohttp_client(create_app(tmp_path))
    assert (await client.get("/api/remotes")).status == 403
    assert api_mod.INGRESS_IP == "172.30.32.2"


# ---------------------------------------------------------------- RF7


async def test_index_versioned_assets(env):
    from acm import __version__

    resp = await env.get("/")
    html = await resp.text()
    assert resp.headers["Cache-Control"] == "no-store"
    assert f'static/map.js?v={__version__}"' in html and "__ACM_VERSION__" not in html
    resp = await env.get(f"/static/map.js?v={__version__}")
    assert resp.status == 200 and resp.headers["Cache-Control"] == "no-cache"


# ---------------------------------------------------------------- RF9 (upstream 1.2.0)


# ---------------------------------------------------------------- 1.2.1-beta


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


# ------------------------------------------------------------- RF12 remote history (app 1.3.0)


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
    # RF21.6: written straight to each remote (no add-on versions in 3.0)
    assert by[rid_a]["result"] == "written" and by[rid_b]["result"] == "written" and by["nope"]["error"]
    dev = env.devices["a"]
    assert json.loads(dev.text)["theme"]["background"] == "#000000"
    assert dev.last_note == "ACM: theme My OLED"
    # Default preset = remote built-ins: the theme block is removed
    res = await (await env.post("/api/themes/preset:default/apply", json={"remotes": [rid_a]})).json()
    assert res["results"][0]["result"] == "written" and "theme" not in json.loads(dev.text)
    again = await (await env.post("/api/themes/preset:default/apply", json={"remotes": [rid_a]})).json()
    assert again["results"][0]["result"] == "unchanged"  # nothing written


# ------------------------------------------------------------- RF16 (upstream 1.3.1-1.3.2-beta, native builder mode)


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


