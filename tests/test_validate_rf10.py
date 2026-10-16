"""Validation rules for the upstream 1.2.2-1.2.7-beta keys (spec RF10.1-RF10.4).

Ranges and accepted values follow DashboardLoader.parseDock / parsePower /
parsePage (astrion-custom-dashboard 1.2.7-beta): bad values are ignored by the
remote, so they are warnings (push still allowed), never blocking issues.
"""

from __future__ import annotations

from acm.validate import validate


def _codes(res, kind="warnings"):
    return {(w["path"], w["code"]) for w in res[kind]}


def base(**extra):
    doc = {
        "pages": [{"name": "Home", "cards": []}],
        "activities": [
            {"id": "tv", "name": "TV", "room": "Salon", "devices": [{"deviceId": "media_player.tv", "source": "ha"}]}
        ],
    }
    doc.update(extra)
    return doc


def test_dock_and_power_ranges_and_entities():
    doc = base(
        dock={
            "mode": "clock",
            "brightness": 1.5,
            "time_format": 24,
            "weather_entity": "weather.home",
            "media_entities": ["media_player.tv"],
            "show_battery": True,
        },
        power={
            "dock_debounce_seconds": 90,
            "motion_wake_minutes": -1,
            "screen_timeout_seconds": "x",
            "screen_off_entities": ["binary_sensor.motion"],
        },
    )
    res = validate(doc, {"weather.home", "media_player.tv"})
    codes = _codes(res)
    assert ("/dock/brightness", "value_range") in codes
    assert ("/power/dock_debounce_seconds", "value_range") in codes
    assert ("/power/screen_timeout_seconds", "type_mismatch") in codes
    assert not any(p == "/power/motion_wake_minutes" for p, _ in codes)  # -1 = disabled, valid
    # unknown entity in power.screen_off_entities -> blocking, like any entity reference
    assert ("/power/screen_off_entities/0", "entity_missing") in _codes(res, "issues")
    assert res["push_allowed"] is False


def test_dock_mode_and_time_format_values():
    res = validate(base(dock={"mode": "night", "time_format": 13}), set())
    assert {("/dock/mode", "value_unexpected"), ("/dock/time_format", "value_unexpected")} <= _codes(res)
    assert res["push_allowed"] is True


def test_hide_mode_and_stop_activity_rooms():
    doc = base()
    doc["pages"].append(
        {
            "name": "TV",
            "hiddenUnlessActivity": "tv",
            "hideMode": "full",
            "cards": [
                {
                    "type": "scene_grid",
                    "options": {
                        "scenes": [
                            {"name": "Off", "stopActivity": "Salon"},
                            {"name": "All off", "stopActivity": "*"},
                            {"name": "Kitchen off", "stopActivity": "Kitchen"},
                            {"name": "Radio", "track": True, "room": "Bedroom"},
                            {"name": "Bed off", "long_press": {"stopActivity": "Bedroom"}},
                        ]
                    },
                }
            ],
        }
    )
    doc["pages"].append({"name": "X", "hideMode": "full", "cards": []})
    doc["pages"].append({"name": "Y", "hiddenUnlessActivity": "tv", "hideMode": "hidden", "cards": []})
    codes = _codes(validate(doc, set()))
    assert ("/pages/1/cards/0/options/scenes/2/stopActivity", "room_unknown") in codes
    assert not any("scenes/0" in p or "scenes/1" in p or "scenes/4" in p for p, _ in codes)
    assert ("/pages/2/hideMode", "hide_mode_unused") in codes
    assert ("/pages/3/hideMode", "value_unexpected") in codes
    assert not any(p == "/pages/1/hideMode" for p, _ in codes)


def test_apple_tv_layout_and_apps():
    card = {
        "type": "apple_tv_remote",
        "options": {"deviceId": "1", "layout": "tiny", "apps": ["Netflix", {"source": "TV"}]},
    }
    codes = _codes(validate(base(pages=[{"name": "A", "cards": [card]}]), set()))
    assert ("/pages/0/cards/0/options/layout", "value_unexpected") in codes
    assert ("/pages/0/cards/0/options/apps/0", "item_not_object") in codes
    assert not any(p.endswith("apps/1") for p, _ in codes)


# ------------------------------------------------- RF11 (upstream 1.2.8-1.2.9-beta)


def test_rf11_popup_hotkey_now_playing_and_dock_room():
    doc = base(dock={"room": "Kitchen"}, hotkeys=[{"key": "MAIN", "page": "Home", "pageMode": "float"}])
    doc["activities"][0]["nowPlayingEntity"] = "media_player.appletv"
    res = validate(doc, {"media_player.tv"})
    codes = _codes(res)
    assert ("/hotkeys/0/pageMode", "value_unexpected") in codes
    assert ("/dock/room", "room_unknown") in codes
    assert ("/activities/0/nowPlayingEntity", "entity_missing") in _codes(res, "issues")
    ok = base(dock={"room": "Salon"}, hotkeys=[{"key": "MAIN", "page": "Home", "pageMode": "popup"}])
    assert not _codes(validate(ok, {"media_player.tv"}))


def test_rf11_select_font_size_and_layout():
    card = {"type": "select", "options": {"entity_id": "input_select.x", "layout": "dropdown", "font_size": 40}}
    codes = _codes(validate(base(pages=[{"name": "A", "cards": [card]}]), set()))
    assert ("/pages/0/cards/0/options/font_size", "value_range") in codes
    assert not any(p.endswith("/layout") for p, _ in codes)
