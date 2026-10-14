"""Tests for the ActivityPlanner port and the IR lookup rules (spec RF10.5, RF10.6).

Expected behaviour is taken from upstream ActivityPlanner.kt / IrDatabaseRuntime.kt
(astrion-custom-dashboard 1.2.7-beta) and its CHANGELOG.
"""

from __future__ import annotations

import pytest
from acm.ir import (
    IRError,
    build_repeated_pronto,
    find_command,
    find_model,
    parse_profile,
    profile_input,
    pronto_to_pattern,
    repair_split_pronto,
    resolve,
)
from acm.planner import ActivityPlanner

TV_PROFILE = parse_profile(
    {
        "power": {"type": "discrete", "on": ["PowerOn"], "off": ["PowerOff"]},
        "timing": {"power_on_delay_ms": 5000, "inter_key_delay_ms": 100, "inter_device_delay_ms": 500, "repeats": 3},
        "inputs": [{"name": "HDMI 1", "steps": ["Input", {"delay_ms": 2500}, "Exit"]}],
    }
)
AMP_PROFILE = parse_profile(
    {"power": {"type": "toggle", "toggle": ["Power"]}, "timing": {"inter_device_delay_ms": 300}}
)


def dev(dev_id, **kw):
    return {"deviceId": dev_id, "source": "ir", **kw}


def summary(plan):
    out = []
    for a in plan["actions"]:
        val = a.get("command") or a.get("source") or ("on" if a.get("on") else "off")
        out.append((a["device"]["deviceId"], a["type"], val, a["gap"]))
    return out


def test_original_order_without_profiles():
    """No profile: power on -> input -> delayAfterMs -> next device (unchanged)."""
    p = ActivityPlanner(lambda d: None, {})
    act = {
        "devices": [
            dev("tv", powerOnCommand="On", inputCommand="Hdmi", delayAfterMs=800),
            dev("amp", powerOnCommand="Pwr"),
        ]
    }
    plan = p.plan_start(act, [], set(), [])
    assert summary(plan) == [("tv", "command", "On", 0), ("tv", "command", "Hdmi", 0), ("amp", "command", "Pwr", 800)]
    assert plan["power"] == {"tv": True, "amp": True} and plan["inputs"] == {"tv": "Hdmi"}


def test_harmony_style_start_with_profiles():
    """Power on staggered, then inputs once each device is ready (delays overlap)."""
    profiles = {"tv": TV_PROFILE, "amp": AMP_PROFILE}
    p = ActivityPlanner(lambda d: profiles.get(d["deviceId"]), {})
    act = {"devices": [dev("tv", inputCommand="HDMI 1"), dev("amp")]}
    plan = p.plan_start(act, [], set(), [])
    # tv PowerOn at 0, amp toggle after tv's inter-device 500, then wait until
    # tv ready (5000) for the named input sequence: Input, +2500 delay, Exit.
    assert summary(plan) == [
        ("tv", "command", "PowerOn", 0),
        ("amp", "command", "Power", 500),
        ("tv", "command", "Input", 4500),
        ("tv", "command", "Exit", 2500),
    ]
    assert plan["inputs"] == {"tv": "HDMI 1"}


def test_toggle_device_known_on_is_not_toggled_and_input_skipped():
    profiles = {"tv": TV_PROFILE, "amp": AMP_PROFILE}
    states = {"amp": {"on": True}, "tv": {"on": True, "input": "hdmi 1"}}
    p = ActivityPlanner(lambda d: profiles.get(d["deviceId"]), states)
    act = {"devices": [dev("tv", inputCommand="HDMI 1"), dev("amp")]}
    # tv discrete + not in outgoing -> safety PowerOn resent, no wait, input kept (known)
    assert summary(p.plan_start(act, [], {"amp"}, [])) == [("tv", "command", "PowerOn", 0)]


def test_power_off_room_devices_known_on():
    """Step 1: room devices known on but unused by the new Activity are turned off."""
    states = {"proj": {"on": True}}
    p = ActivityPlanner(lambda d: None, states)
    room = [dev("proj", powerOffCommand="Off"), dev("tv")]
    plan = p.plan_start({"devices": [dev("tv", powerOnCommand="On")]}, room, set(), [])
    assert summary(plan)[:1] == [("proj", "command", "Off", 0)]


def test_stop_skips_devices_known_off_and_ha_power():
    p = ActivityPlanner(lambda d: None, {"tv": {"on": False}})
    act = {"devices": [dev("tv", powerOffCommand="Off"), {"deviceId": "media_player.x", "source": "ha"}]}
    assert summary(p.plan_stop(act)) == [("media_player.x", "ha_power", "off", 0)]


def test_explicit_power_missing_falls_back_to_profile():
    """An explicit power command the device lacks falls back to the profile's own."""
    p = ActivityPlanner(lambda d: TV_PROFILE, {}, has_command=lambda d, c: c != "PowerToggle")
    plan = p.plan_start({"devices": [dev("tv", powerOnCommand="PowerToggle")]}, [], set(), [])
    assert summary(plan)[0][2] == "PowerOn"


def test_hold_step_repeats_frames():
    prof = parse_profile({"power": {"type": "discrete", "on": [{"hold": "Power", "duration_ms": 550}]}})
    p = ActivityPlanner(lambda d: prof, {})
    plan = p.plan_start({"devices": [dev("tv")]}, [], set(), [])
    assert [a["command"] for a in plan["actions"]] == ["Power"] * 5


# ------------------------------------------------------------ IR lookup rules

PRONTO = "0000 006D 0002 0001 0157 00AC 0015 0016 0015 0016"


def test_repeats_and_separate_repeat_burst():
    once = "0000 006D 0001 0000 0157 00AC"
    rep = "0000 006D 0001 0000 0015 0016"
    assert build_repeated_pronto(once, rep, 3) == "0000 006D 0003 0000 0157 00AC 0015 0016 0015 0016"
    assert build_repeated_pronto(once, None, 1) == once
    # repeat burst on another carrier is ignored -> the code's own frame
    assert build_repeated_pronto(once, "0000 0070 0001 0000 0001 0001", 2).count("0157") == 2


def test_repair_split_pronto():
    full = "0000 006D 0002 0000 0157 00AC 0015 0016"
    head, tail = "0000 006D 0002", "0000 0157 00AC 0015 0016"
    assert repair_split_pronto(tail, head) == (full, None)
    assert repair_split_pronto(full, "0000 006D 0001 0000 0015 0016")[1] is not None  # healthy: unchanged


def test_model_and_command_matching():
    db = {
        "brands": [
            {
                "brand_name": "Sony",
                "models": [{"model_name": "KD-55 (Harmony)", "commands": {"VolumeUp": {"pronto": PRONTO}}}],
            }
        ]
    }
    model = find_model(db, "sony", "kd-55")
    assert model is not None and find_command(model["commands"], "volume_up") is not None
    assert find_model(db, "sony", "other") is None


def test_profile_input_aliases():
    prof = parse_profile({"inputs": [{"name": "HDMI 2", "steps": ["I2"]}]})
    assert profile_input(prof, "hdmi2") == [{"send": "I2"}]
    assert profile_input(prof, "InputHdmi2") == [{"send": "I2"}]
    assert profile_input(prof, "HDMI 3") is None


async def test_resolve_applies_profile_repeats():
    db = {
        "brands": [
            {
                "brand_name": "Sony",
                "models": [
                    {
                        "model_name": "KD",
                        "commands": {"Power": {"pronto": PRONTO}},
                        "profile": {"timing": {"repeats": 2}},
                    }
                ],
            }
        ]
    }

    async def fetch(_):
        return db

    step = await resolve({"id": "tv", "category": "tv", "brand": "Sony", "model": "KD"}, "power", fetch)
    assert step["pronto"].startswith("0000 006D 0003 0000")
    assert len(step["pattern"]) == len(pronto_to_pattern(step["pronto"])["pattern"]) == 6
    with pytest.raises(IRError):
        await resolve({"id": "tv", "category": "tv", "brand": "Sony", "model": "KD"}, "Nope", fetch)
