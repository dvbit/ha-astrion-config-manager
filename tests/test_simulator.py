"""Tests for v2.0 real execution (spec RF6.5, RF6.7, RF6.8, criteria 7-9)."""

from __future__ import annotations

import base64
import json

import aiohttp
import pytest
from acm.actions import Executor
from acm.device import DeviceClient
from acm.harmony import HarmonyRegistry
from acm.ir import pronto_to_pattern, pulses_to_broadlink, to_b64_command
from aiohttp import web

PRONTO = "0000 006D 0002 0000 0157 00AC 0015 0016"


def test_pronto_to_pattern():
    step = pronto_to_pattern(PRONTO)
    assert step["freq"] == round(4145146 / 0x6D)
    period = 1_000_000 / step["freq"]
    assert step["pattern"] == [round(w * period) for w in (0x157, 0xAC, 0x15, 0x16)]


def test_broadlink_packet():
    # 9000us -> 274 ticks (escaped 00 01 12), 4500 -> 137, 560 -> 17
    assert pulses_to_broadlink([9000, 4500, 560]) == bytes.fromhex("2600050000011289 11".replace(" ", ""))
    cmd = to_b64_command({"freq": 38000, "pattern": [9000, 4500, 560]})
    assert cmd.startswith("b64:") and base64.b64decode(cmd[4:])[0] == 0x26


class FakeHA:
    def __init__(self):
        self.calls = []

    async def call_service(self, domain, service, entity_id=None, data=None):
        self.calls.append((f"{domain}.{service}", entity_id, data))


@pytest.fixture
async def hub(aiohttp_server):
    """Fake Harmony Hub: discovery POST + websocket recording messages."""
    received = []

    async def root(request):
        if request.method == "POST":
            assert request.headers["Origin"] == "http://sl.dhg.myharmony.com"
            body = await request.json()
            assert body["cmd"] == "setup.account?getProvisionInfo"
            return web.json_response({"data": {"activeRemoteId": "12345"}})
        assert request.query["hubId"] == "12345"
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        async for msg in ws:
            received.append(json.loads(msg.data))
        return ws

    app = web.Application()
    app.router.add_route("*", "/", root)
    server = await aiohttp_server(app)
    server.received = received
    return server


@pytest.fixture
async def device(aiohttp_server):
    model = {"model_name": "KD-55", "commands": {"power": {"pronto": PRONTO}}}
    db = {"brands": [{"brand_name": "Sony", "models": [model]}]}

    async def irdb(request):
        assert request.match_info["cat"] == "tv"
        return web.json_response(db)

    app = web.Application()
    app.router.add_get("/ir-database/{cat}.json", irdb)
    return await aiohttp_server(app)


DOC = {
    "pages": [{"name": "Home", "cards": []}],
    "irDevices": [
        {"id": "amp", "commands": {"on": {"freq": 38000, "pattern": [9000, 4500, 560]}}},
        {"id": "tv", "category": "tv", "brand": "sony", "model": "kd-55"},
    ],
    "activities": [
        {
            "id": "watch",
            "room": "salotto",
            "devices": [
                {"deviceId": "media_player.tv", "source": "ha", "inputCommand": "HDMI 1", "delayAfterMs": 1},
                {"deviceId": "amp", "source": "ir", "powerOnCommand": "on"},
            ],
        },
        {
            "id": "music",
            "room": "salotto",
            "devices": [
                {"deviceId": "amp", "source": "ir", "powerOnCommand": "on"},
                {"deviceId": "555", "source": "harmony", "inputCommand": "InputAux"},
            ],
        },
    ],
}


@pytest.fixture
async def executor(hub, device):
    async with aiohttp.ClientSession() as http:
        ha = FakeHA()
        ex = Executor(ha, HarmonyRegistry(http, port=hub.port), DeviceClient, http)
        meta = {
            "id": "r1",
            "name": "R",
            "host": device.host,
            "port": device.port,
            "harmony_ip": hub.host,
            "ir_entity": "remote.broadlink",
        }
        yield ex, ha, meta, hub


async def test_c7_service_call(executor):
    ex, ha, meta, _ = executor
    res = await ex.run(meta, DOC, [{"kind": "service", "service": "light.toggle", "entity_id": "light.salotto"}])
    assert res["results"] == [{"kind": "service", "ok": True}]
    assert ha.calls == [("light.toggle", "light.salotto", None)]


async def test_c8_harmony(executor):
    ex, _, meta, hub = executor
    res = await ex.run(
        meta,
        DOC,
        [
            {"kind": "harmony_command", "device": "62845789", "command": "VolumeUp"},
            {"kind": "harmony_activity", "activity": "-1"},
        ],
    )
    assert all(r["ok"] for r in res["results"])
    import asyncio

    await asyncio.sleep(0.1)
    cmds = [m["hbus"]["cmd"] for m in hub.received]
    hold = "vnd.logitech.harmony/vnd.logitech.harmony.engine?holdAction"
    assert cmds == [hold, hold, "harmony.activityengine?runactivity"]
    press, release = (m["hbus"]["params"] for m in hub.received[:2])
    assert (press["status"], release["status"]) == ("press", "release")
    assert json.loads(press["action"]) == {"type": "IRCommand", "deviceId": "62845789", "command": "VolumeUp"}
    assert hub.received[0]["hubId"] == "12345" and hub.received[0]["timeout"] == 30
    # without Hub IP: disabled with reason
    res = await ex.run({**meta, "harmony_ip": None}, DOC, [{"kind": "harmony_activity", "activity": "1"}])
    assert res["results"][0]["error"] == "harmony_not_configured"


async def test_c9_ir(executor):
    ex, ha, meta, _ = executor
    res = await ex.run(
        meta,
        DOC,
        [{"kind": "ir", "device": "amp", "command": "on"}, {"kind": "ir", "device": "tv", "command": "power"}],
    )
    assert all(r["ok"] for r in res["results"]), res
    assert ha.calls[0] == (
        "remote.send_command",
        "remote.broadlink",
        {"command": to_b64_command({"pattern": [9000, 4500, 560]})},
    )
    assert ha.calls[1][2]["command"] == to_b64_command(pronto_to_pattern(PRONTO))
    res = await ex.run({**meta, "ir_entity": None}, DOC, [{"kind": "ir", "device": "amp", "command": "on"}])
    assert res["results"][0]["error"] == "ir_not_configured"
    res = await ex.run(meta, DOC, [{"kind": "ir", "device": "amp", "command": "nope"}])
    assert res["results"][0]["error"] == "ir_command_not_found"


async def test_composed_activity_switch(executor):
    ex, ha, meta, hub = executor
    res = await ex.run(meta, DOC, [{"kind": "activity", "id": "watch"}])
    assert res["results"][0]["ok"] and res["active"] == {"salotto": "watch"}
    assert [c[0] for c in ha.calls] == ["media_player.turn_on", "media_player.select_source", "remote.send_command"]
    ha.calls.clear()
    # switching: tv (not in "music", powerOffOnExit default) goes off, amp stays on
    res = await ex.run(meta, DOC, [{"kind": "activity", "id": "music"}])
    assert res["active"] == {"salotto": "music"}
    assert ha.calls[0] == ("media_player.turn_off", "media_player.tv", None)
    assert len(ha.calls) == 1  # amp already on: no power command
    res = await ex.run(meta, DOC, [{"kind": "activity_stop", "room": "salotto"}])
    assert res["active"] == {}


# ---------------------------------------------------------------- RF8


def test_pattern_to_pronto_roundtrip():
    from acm.ir import pattern_to_pronto

    pronto = pattern_to_pronto(38000, [9000, 4500, 560, 560, 560])  # odd -> final gap
    back = pronto_to_pattern(pronto)
    assert back["freq"] == round(4145146 / round(4145146 / 38000))
    assert len(back["pattern"]) == 6
    assert all(abs(a - b) <= 27 for a, b in zip(back["pattern"], [9000, 4500, 560, 560, 560], strict=False))


@pytest.fixture
async def multi(aiohttp_server, hub, device):
    """Second hub on 127.0.0.2 (same port) + one IR extender."""
    received2 = []

    async def root(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        async for msg in ws:
            received2.append(json.loads(msg.data))
        return ws

    app2 = web.Application()
    app2.router.add_route("*", "/", root)
    await aiohttp_server(app2, host="127.0.0.2", port=hub.port)  # second hub
    bodies = []

    async def pronto(request):
        assert request.content_type == "text/plain"
        bodies.append(await request.text())
        return web.Response(text="ok")

    app3 = web.Application()
    app3.router.add_post("/pronto", pronto)
    ext = await aiohttp_server(app3)
    async with aiohttp.ClientSession() as http:
        ha = FakeHA()
        ex = Executor(ha, HarmonyRegistry(http, port=hub.port), DeviceClient, http)
        meta = {
            "id": "r2",
            "name": "R",
            "host": device.host,
            "port": device.port,
            "harmony_ip": None,
            "ir_entity": None,
            "harmony_hubs": [
                {"localId": "h1", "name": "Salotto", "ip": hub.host, "hubId": ""},
                {"localId": "h2", "name": "Camera", "ip": "127.0.0.2", "hubId": "999"},  # known id: no discovery
            ],
            "extenders": [{"localId": "x1", "name": "Ext TV", "host": f"{ext.host}:{ext.port}"}],
        }
        yield ex, ha, meta, hub, received2, bodies


async def test_rf8_multiple_hubs(multi):
    import asyncio

    ex, _, meta, hub, received2, _ = multi
    res = await ex.run(
        meta,
        DOC,
        [
            {"kind": "harmony_activity", "activity": "1", "hub": "h2"},
            {"kind": "harmony_activity", "activity": "2", "hub": "nope"},  # unknown -> first hub
            {"kind": "harmony_activity", "activity": "3"},  # missing -> first hub
        ],
    )
    assert all(r["ok"] for r in res["results"]), res
    await asyncio.sleep(0.1)
    assert [m["hbus"]["params"]["activityId"] for m in received2] == ["1"]
    assert received2[0]["hubId"] == "999"
    assert [m["hbus"]["params"]["activityId"] for m in hub.received] == ["2", "3"]


async def test_rf8_extender(multi):
    from acm.ir import pattern_to_pronto

    ex, ha, meta, _, _, bodies = multi
    doc = {
        **DOC,
        "irDevices": [
            {
                "id": "amp",
                "target": {"extender": "x1"},
                "commands": {"on": {"freq": 38000, "pattern": [9000, 4500, 560, 560]}},
            },
            {"id": "tv", "target": {"extender": "x1"}, "category": "tv", "brand": "sony", "model": "kd-55"},
            {"id": "bad", "target": {"extender": "zz"}, "commands": {"on": {"freq": 38000, "pattern": [1, 2]}}},
            {"id": "loc", "commands": {"on": {"freq": 38000, "pattern": [1, 2]}}},
        ],
    }
    res = await ex.run(
        meta,
        doc,
        [
            {"kind": "ir", "device": d, "command": c}
            for d, c in (("amp", "on"), ("tv", "power"), ("bad", "on"), ("loc", "on"))
        ],
    )
    assert [r.get("error") for r in res["results"]] == [None, None, "ir_extender_unknown", "ir_not_configured"]
    assert bodies == [pattern_to_pronto(38000, [9000, 4500, 560, 560]), PRONTO]
    assert ha.calls == []


async def test_rf9_appletv_direct_not_executable(executor):
    ex, ha, meta, _ = executor
    step = {
        "kind": "service",
        "service": "astrion_appletv.send_command",
        "entity_id": "media_player.appletv_salon",
        "data": {"command": "Menu"},
    }
    res = await ex.run(meta, DOC, [step])
    assert res["results"][0]["error"] == "appletv_direct" and ha.calls == []
