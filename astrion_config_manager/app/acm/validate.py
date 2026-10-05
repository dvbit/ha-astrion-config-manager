"""Validation of a ``dashboard.json`` state (spec RF4).

Structural rules mirror the upstream parser
``app/src/main/java/com/custom/astrion/config/DashboardLoader.kt`` and the
card option accessors (``CardConfig.string/stringList/bool/int``) of each
renderer under ``cards/impl/`` (extracted to ``static/card_schema.json``).

* RF4.1 structural errors, including Harmony and IR parts.
* RF4.2 every entity id referenced in *known* fields must exist in HA;
  unknown cards are preserved untouched (RF3.2) and not inspected.
* RF4.3 Harmony/IR: structure only, no check against the Hub or emitter.
* RF7.5 ``haDevices`` catalog (structure + entity existence).
* RF7.4 every icon path must exist in the add-on library or on the remote.

Each issue is ``{"path": <JSON pointer>, "code": <i18n key>, "params": {}}``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .icons import collect_refs

SCHEMA: dict[str, Any] = json.loads((Path(__file__).parent / "static" / "card_schema.json").read_text("utf-8"))

# HardwareKey enum of input/HardwareKeys.kt (HA100 physical buttons).
HARDWARE_KEYS = {
    "BACK",
    "HOME",
    "POWER",
    "VOLUME_UP",
    "VOLUME_DOWN",
    "PAGE_UP",
    "PAGE_DOWN",
    "UP",
    "DOWN",
    "LEFT",
    "RIGHT",
    "CENTER",
    "MUTE",
    "VOICE",
    "MAIN",
    "REWIND",
    "PLAY",
    "STOP",
    "FASTFORWARD",
    "RED_BUTTON",
    "GREEN_BUTTON",
    "BLUE_BUTTON",
    "YELLOW_BUTTON",
}

# Keys whose value is an HA entity id (or a list of them) in known parts.
ENTITY_KEYS = {
    "entity",
    "entity_id",
    "entityId",
    "entities",
    "openWhenEntity",
    "master",
    "speakers",
    "state_entity",
    "calendar_entity",
    "vacuum",
}
_ENTITY_RE = re.compile(r"^[a-z_]+\.[a-z0-9_]+$")

ACTIVITY_SOURCES = {"ir", "harmony", "ha"}

# Catalog types of the remote's "Add device" form (docs/devices.html) and the
# entity domains each accepts ("select" covers input_select too).
HA_DEVICE_DOMAINS = {
    "light": {"light"},
    "switch": {"switch"},
    "cover": {"cover"},
    "climate": {"climate"},
    "media_player": {"media_player"},
    "camera": {"camera"},
    "fan": {"fan"},
    "vacuum": {"vacuum"},
    "weather": {"weather"},
    "select": {"select", "input_select"},
}

_KIND_CHECK = {
    "string": lambda v: isinstance(v, str),
    "bool": lambda v: isinstance(v, bool),
    "int": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "string_list": lambda v: isinstance(v, list) and all(isinstance(x, str) for x in v),
    "json": lambda v: True,
}


def _ptr(*parts: Any) -> str:
    """Build a JSON pointer (RFC 6901) from path parts."""
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in parts)


class _Ctx:
    def __init__(self) -> None:
        self.issues: list[dict[str, Any]] = []
        self.entities: dict[str, list[str]] = {}

    def err(self, path: str, code: str, **params: Any) -> None:
        self.issues.append({"path": path, "code": code, "params": params})

    def entity(self, path: str, value: Any) -> None:
        """Record entity ids found under an entity key (RF4.2)."""
        values = value if isinstance(value, list) else [value]
        for idx, item in enumerate(values):
            sub = path if not isinstance(value, list) else f"{path}/{idx}"
            if isinstance(item, str) and _ENTITY_RE.match(item):
                self.entities.setdefault(item, []).append(sub)
            elif isinstance(item, dict):
                self.walk_entities(item, sub)

    def walk_entities(self, node: Any, path: str) -> None:
        """Recursively collect entity ids in a known sub-tree."""
        if isinstance(node, dict):
            for key, val in node.items():
                sub = f"{path}{_ptr(key)}"
                if key in ENTITY_KEYS or key.endswith(("_entity", "Entity")):
                    self.entity(sub, val)
                else:
                    self.walk_entities(val, sub)
        elif isinstance(node, list):
            for idx, val in enumerate(node):
                self.walk_entities(val, f"{path}/{idx}")


def _card(ctx: _Ctx, card: Any, path: str) -> None:
    """Card = ``{"type": str, "options": {...}}`` (DashboardLoader.parseCard)."""
    if not isinstance(card, dict):
        ctx.err(path, "type_mismatch", expected="object")
        return
    ctype = card.get("type")
    if not isinstance(ctype, str):
        ctx.err(_ptr_join(path, "type"), "required", field="type")
        return
    opts = card.get("options", {})
    if not isinstance(opts, dict):
        ctx.err(_ptr_join(path, "options"), "type_mismatch", expected="object")
        return
    spec = SCHEMA.get(ctype)
    if spec is None:
        return  # RF3.2: unknown card kept intact, not validated
    for key, fspec in spec["fields"].items():
        if key in opts and opts[key] is not None and not _KIND_CHECK[fspec["kind"]](opts[key]):
            ctx.err(_ptr_join(path, "options", key), "type_mismatch", expected=fspec["kind"])
    ctx.walk_entities(opts, _ptr_join(path, "options"))
    # row cards nest other cards.
    if ctype == "row" and isinstance(opts.get("cards"), list):
        for idx, sub in enumerate(opts["cards"]):
            _card(ctx, sub, _ptr_join(path, "options", "cards", idx))


def _ptr_join(base: str, *parts: Any) -> str:
    return base + _ptr(*parts)


def _hotkeys(ctx: _Ctx, items: Any, path: str) -> None:
    """Hotkeys (DashboardLoader.parseHotkey): ``key`` required, HA100 key names."""
    if not isinstance(items, list):
        ctx.err(path, "type_mismatch", expected="array")
        return
    for idx, hk in enumerate(items):
        hp = f"{path}/{idx}"
        if not isinstance(hk, dict):
            ctx.err(hp, "type_mismatch", expected="object")
            continue
        key = hk.get("key")
        if not isinstance(key, str):
            ctx.err(f"{hp}/key", "required", field="key")
        elif key not in HARDWARE_KEYS:
            ctx.err(f"{hp}/key", "hotkey_unknown", key=key)
        if "data" in hk and not isinstance(hk["data"], dict):
            ctx.err(f"{hp}/data", "type_mismatch", expected="object")
        ctx.walk_entities(hk, hp)


def _ir_devices(ctx: _Ctx, items: Any, path: str) -> None:
    """IR devices (DashboardLoader.parseIrDevice / parseIrStep / parseIrTarget)."""
    if not isinstance(items, list):
        ctx.err(path, "type_mismatch", expected="array")
        return
    for idx, dev in enumerate(items):
        dp = f"{path}/{idx}"
        if not isinstance(dev, dict):
            ctx.err(dp, "type_mismatch", expected="object")
            continue
        if not isinstance(dev.get("id"), str):
            ctx.err(f"{dp}/id", "required", field="id")
        if "commands" in dev:
            cmds = dev["commands"]
            if not isinstance(cmds, dict) or not cmds:
                ctx.err(f"{dp}/commands", "ir_commands_empty")
            else:
                for cid, step in cmds.items():
                    _ir_step(ctx, step, f"{dp}/commands{_ptr(cid)}")
        elif not all(isinstance(dev.get(k), str) for k in ("category", "brand", "model")):
            ctx.err(dp, "ir_source_missing")
        target = dev.get("target")
        if target is not None and target != "local":
            ok = isinstance(target, dict) and isinstance(target.get("extender"), str) and target["extender"].strip()
            if not ok:
                ctx.err(f"{dp}/target", "ir_target_invalid")


def _ir_step(ctx: _Ctx, step: Any, path: str) -> None:
    if not isinstance(step, dict):
        ctx.err(path, "type_mismatch", expected="object")
        return
    if not isinstance(step.get("freq"), int) or isinstance(step.get("freq"), bool):
        ctx.err(f"{path}/freq", "required", field="freq")
    pat = step.get("pattern")
    if not isinstance(pat, list) or not pat or not all(isinstance(x, int) for x in pat):
        ctx.err(f"{path}/pattern", "ir_pattern_invalid")


def _activities(ctx: _Ctx, items: Any, path: str) -> None:
    """Composed Activities (DashboardLoader.parseActivity / parseActivityDevice)."""
    if not isinstance(items, list):
        ctx.err(path, "type_mismatch", expected="array")
        return
    for idx, act in enumerate(items):
        ap = f"{path}/{idx}"
        if not isinstance(act, dict):
            ctx.err(ap, "type_mismatch", expected="object")
            continue
        for key in ("id", "room"):
            if not isinstance(act.get(key), str) or not act[key].strip():
                ctx.err(f"{ap}/{key}", "required", field=key)
        devs = act.get("devices")
        if not isinstance(devs, list) or not devs:
            ctx.err(f"{ap}/devices", "required", field="devices")
            continue
        for didx, dev in enumerate(devs):
            dpp = f"{ap}/devices/{didx}"
            if not isinstance(dev, dict):
                ctx.err(dpp, "type_mismatch", expected="object")
                continue
            if not isinstance(dev.get("deviceId"), str):
                ctx.err(f"{dpp}/deviceId", "required", field="deviceId")
            if dev.get("source") not in ACTIVITY_SOURCES:
                ctx.err(f"{dpp}/source", "activity_source_invalid")
            if "delayAfterMs" in dev and not isinstance(dev["delayAfterMs"], int):
                ctx.err(f"{dpp}/delayAfterMs", "type_mismatch", expected="int")


def _ha_devices(ctx: _Ctx, items: Any, path: str) -> None:
    """RF7.5: entity catalog ``[{id, domain, entityId, name}]`` (devices-page.js)."""
    if not isinstance(items, list):
        ctx.err(path, "type_mismatch", expected="array")
        return
    seen: set[str] = set()
    for idx, dev in enumerate(items):
        dp = f"{path}/{idx}"
        if not isinstance(dev, dict):
            ctx.err(dp, "type_mismatch", expected="object")
            continue
        for key in ("id", "domain", "entityId", "name"):
            if not isinstance(dev.get(key), str) or not dev[key].strip():
                ctx.err(f"{dp}/{key}", "required", field=key)
        dom, ent = dev.get("domain"), dev.get("entityId")
        if isinstance(dom, str) and dom not in HA_DEVICE_DOMAINS:
            ctx.err(f"{dp}/domain", "ha_device_domain", domain=dom)
        elif isinstance(dom, str) and isinstance(ent, str) and ent.split(".")[0] not in HA_DEVICE_DOMAINS[dom]:
            ctx.err(f"{dp}/entityId", "ha_device_domain", domain=dom)
        if isinstance(dev.get("id"), str):
            if dev["id"] in seen:
                ctx.err(f"{dp}/id", "duplicate_id", id=dev["id"])
            seen.add(dev["id"])
        if isinstance(ent, str) and ent:
            ctx.entity(f"{dp}/entityId", ent)


def structural(doc: Any) -> _Ctx:
    """RF4.1 structural validation; also collects entity references."""
    ctx = _Ctx()
    if isinstance(doc, list):  # legacy form: a bare list of cards = one page
        for idx, card in enumerate(doc):
            _card(ctx, card, f"/{idx}")
        return ctx
    if not isinstance(doc, dict):
        ctx.err("", "root_invalid")
        return ctx
    pages = doc.get("pages")
    if not isinstance(pages, list):
        ctx.err("/pages", "required", field="pages")
    elif not pages:
        ctx.err("/pages", "pages_empty")
    else:
        for idx, page in enumerate(pages):
            pp = f"/pages/{idx}"
            if not isinstance(page, dict):
                ctx.err(pp, "type_mismatch", expected="object")
                continue
            cards = page.get("cards", [])
            if not isinstance(cards, list):
                ctx.err(f"{pp}/cards", "type_mismatch", expected="array")
            else:
                for cidx, card in enumerate(cards):
                    _card(ctx, card, f"{pp}/cards/{cidx}")
            for hk in ("hotkeys", "longHotkeys"):
                if hk in page:
                    _hotkeys(ctx, page[hk], f"{pp}/{hk}")
            if "openWhenEntity" in page:
                ctx.entity(f"{pp}/openWhenEntity", page["openWhenEntity"])
    if "startPage" in doc and (not isinstance(doc["startPage"], int) or isinstance(doc["startPage"], bool)):
        ctx.err("/startPage", "type_mismatch", expected="int")
    for hk in ("hotkeys", "longHotkeys"):
        if hk in doc:
            _hotkeys(ctx, doc[hk], f"/{hk}")
    if "irDevices" in doc:
        _ir_devices(ctx, doc["irDevices"], "/irDevices")
    if "activities" in doc:
        _activities(ctx, doc["activities"], "/activities")
    if "haDevices" in doc:
        _ha_devices(ctx, doc["haDevices"], "/haDevices")
    if "theme" in doc and not isinstance(doc["theme"], dict):
        ctx.err("/theme", "type_mismatch", expected="object")
    return ctx


def validate(doc: Any, known_entities: set[str] | None, known_icons: set[str] | None = None) -> dict[str, Any]:
    """Full validation; ``known_entities`` None means HA is unreachable.

    ``known_icons`` = library + remote icon names; None = remote list unknown
    (unreachable), in which case icon paths are not reported (RF7.4).

    Returns ``{"issues": [...], "entities_checked": bool, "push_allowed": bool}``.
    RF4.5: push is allowed only with no issue and a successful entity check.
    """
    ctx = structural(doc)
    issues = list(ctx.issues)
    if known_entities is not None:
        for ent, paths in sorted(ctx.entities.items()):
            if ent not in known_entities:
                for path in paths:
                    issues.append({"path": path, "code": "entity_missing", "params": {"entity": ent}})
    if known_icons is not None:
        for name, paths in sorted(collect_refs(doc).items()):
            if name not in known_icons:
                for path in paths:
                    issues.append({"path": path, "code": "icon_missing", "params": {"icon": name}})
    return {
        "issues": issues,
        "entities_checked": known_entities is not None,
        "push_allowed": not issues and known_entities is not None,
    }
