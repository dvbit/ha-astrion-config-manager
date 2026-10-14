"""IR code resolution and conversion for the HA ``remote.*`` emitter (spec RF6.8).

Sources of an IR command (upstream ``config/DashboardLoader.kt`` and
``config/IrDatabaseRuntime.kt``):

* inline device: ``commands[<id>] = {"freq": Hz, "pattern": [µs, ...]}``;
* ir-database device: ``category``/``brand``/``model`` -> Pronto Hex code in
  ``/ir-database/<category>.json`` on the remote, layout
  ``{brands:[{brand_name, models:[{model_name, commands:{id:{pronto}}}]}]}``,
  matched case-insensitively on brand and model as upstream does.

Since upstream 1.2.2-beta (RF10.6) the lookup also follows
``IrDatabaseRuntime.kt``:

* a model named ``"<model> (Harmony)"`` matches ``<model>`` and vice versa;
* command ids match exactly, else ignoring case, spaces, ``_`` and ``-``;
* codes split in two by the old IR sniffer (< 0.4.1) are rejoined
  (``repairSplitPronto``);
* a model ``profile`` (IrDeviceProfile.kt) sets the key repeats: each press is
  one Pronto whose "once" section holds the frame plus ``repeats - 1`` repeat
  frames (``pronto_repeat`` first), capped at 1.9 s (``buildRepeatedPronto``).

Conversion target: Broadlink packet, sent as ``b64:<base64>`` with
``remote.send_command`` (HA Broadlink integration).  The packet layout is the
one of ``python-broadlink`` ``remote.pulses_to_data`` (library used by HA):
type 0x26, 2-byte little-endian length, durations in 32.84 µs ticks with a
0x00 escape for values above 255.  The carrier frequency is not part of the
packet (Broadlink transmits at a fixed ~38 kHz): accepted limitation.
"""

from __future__ import annotations

import base64
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

_LOGGER = logging.getLogger(__name__)

BROADLINK_TICK_US = 32.84


class IRError(Exception):
    """IR command cannot be resolved/converted; ``code`` for the UI."""

    def __init__(self, code: str, detail: str = "") -> None:
        """Keep a stable error code and a technical detail."""
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


def pronto_to_pattern(pronto: str) -> dict[str, Any]:
    """Port of upstream ``prontoToPattern``: learned Pronto (type 0000) -> freq/pattern."""
    try:
        words = [int(w, 16) for w in pronto.split()]
    except ValueError as err:
        raise IRError("ir_bad_pronto", str(err)) from err
    if len(words) < 4 or words[0] != 0x0000 or words[1] == 0:
        raise IRError("ir_bad_pronto", "only learned (0000) codes with a frequency are supported")
    carrier = round(4145146.0 / words[1])
    period_us = 1_000_000.0 / carrier
    once_len, repeat_len = words[2], words[3]
    rest = words[4:]
    once = rest[: once_len * 2]
    repeat = rest[once_len * 2 : once_len * 2 + repeat_len * 2]
    chosen = once or repeat
    if not chosen:
        raise IRError("ir_bad_pronto", "no once/repeat section")
    return {"freq": carrier, "pattern": [round(w * period_us) for w in chosen]}


def pattern_to_pronto(freq: int, pattern: list[int]) -> str:
    """RF8.5: inline ``freq/pattern`` -> learned Pronto (0000), for extenders.

    Inverse of :func:`pronto_to_pattern`; an odd-length pattern gets a final
    gap so burst pairs are complete.
    """
    if not freq or not pattern:
        raise IRError("ir_bad_pattern")
    freq_word = round(4145146.0 / freq)
    period_us = 1_000_000.0 / (4145146.0 / freq_word)
    words = [max(1, round(us / period_us)) for us in pattern]
    if len(words) % 2:
        words.append(max(1, round(10_000 / period_us)))
    head = [0x0000, freq_word, len(words) // 2, 0]
    return " ".join(f"{w:04X}" for w in head + words)


def pulses_to_broadlink(pulses: list[int], tick: float = BROADLINK_TICK_US) -> bytes:
    """Encode µs pulses as a Broadlink packet (python-broadlink ``pulses_to_data``)."""
    result = bytearray(4)
    result[0] = 0x26
    for pulse in pulses:
        div, mod = divmod(int(pulse // tick), 256)
        if div:
            result.append(0)
            result.append(div)
        result.append(mod)
    data_len = len(result) - 4
    result[2] = data_len & 0xFF
    result[3] = data_len >> 8
    return bytes(result)


def to_b64_command(step: dict[str, Any]) -> str:
    """Return the ``b64:...`` string accepted by Broadlink ``remote.send_command``."""
    return "b64:" + base64.b64encode(pulses_to_broadlink(step["pattern"])).decode("ascii")


# --------------------------------------------------------------------------
# Pronto helpers (upstream IrDeviceProfile.kt: ProntoWords, repairSplitPronto,
# buildRepeatedPronto)
# --------------------------------------------------------------------------

MAX_IR_PATTERN_US = 1_900_000  # Android's IR HAL limit, kept for identical codes
_MIN_CARRIER_HZ, _MAX_CARRIER_HZ = 20_000, 60_000


def _pronto_words(code: str) -> tuple[int, list[int], list[int]] | None:
    """(freq word, once, repeat) of a complete learned Pronto, else None."""
    words = []
    for tok in str(code).split():
        try:
            words.append(int(tok, 16))
        except ValueError:
            continue
    if len(words) < 4 or words[0] != 0x0000 or words[1] == 0:
        return None
    once_len, rep_len = words[2] * 2, words[3] * 2
    if len(words) < 4 + once_len + rep_len:  # truncated
        return None
    rest = words[4:]
    return words[1], rest[:once_len], rest[once_len : once_len + rep_len]


def _is_plausible(code: str) -> bool:
    parsed = _pronto_words(code)
    if parsed is None:
        return False
    freq, once, rep = parsed
    exact = len(str(code).split()) == 4 + len(once) + len(rep)
    return exact and _MIN_CARRIER_HZ <= int(4145146.0 / freq) <= _MAX_CARRIER_HZ


def repair_split_pronto(pronto: str, pronto_repeat: str | None) -> tuple[str, str | None]:
    """Port of ``repairSplitPronto``: rejoin a code the old sniffer split in two."""
    if pronto_repeat and not _is_plausible(pronto):
        joined = f"{pronto_repeat} {pronto}"
        if _is_plausible(joined):
            return joined, None
    return pronto, pronto_repeat


def build_repeated_pronto(pronto: str, pronto_repeat: str | None, repeats: int) -> str:
    """Port of ``buildRepeatedPronto``: one press = frame + (repeats-1) repeat frames."""
    main = _pronto_words(pronto)
    base = (main[1] or main[2]) if main else []
    if repeats <= 1 or main is None or not base:
        return pronto
    sep = _pronto_words(pronto_repeat) if pronto_repeat else None
    frame = (sep[1] or sep[2]) if sep and sep[0] == main[0] else []
    frame = frame or main[2] or base
    period_us = 1_000_000.0 / (4145146.0 / main[0])
    frame_us = max(1, int(sum(frame) * period_us))
    extra = min(repeats - 1, max(0, int((MAX_IR_PATTERN_US - int(sum(base) * period_us)) / frame_us)))
    if extra == 0:
        return pronto
    words = base + frame * extra
    return " ".join(f"{w:04X}" for w in [0x0000, main[0], len(words) // 2, 0] + words)


# --------------------------------------------------------------------------
# Profiles (upstream IrDeviceProfile.parse - lenient)
# --------------------------------------------------------------------------


def _ms(obj: dict, key: str) -> int:
    val = obj.get(key)
    return max(0, min(60_000, val)) if isinstance(val, int) and not isinstance(val, bool) else 0


def parse_steps(items: Any) -> list[dict[str, Any]]:
    """IrMacroStep list: "Cmd" | {"delay_ms"} | {"hold", "duration_ms"}."""
    out: list[dict[str, Any]] = []
    for el in items if isinstance(items, list) else []:
        if isinstance(el, str) and el.strip():
            out.append({"send": el.strip()})
        elif isinstance(el, dict):
            if isinstance(el.get("delay_ms"), int):
                out.append({"delay": max(0, el["delay_ms"])})
            elif isinstance(el.get("hold"), str) and el["hold"].strip():
                dur = el.get("duration_ms") if isinstance(el.get("duration_ms"), int) else 0
                out.append({"hold": el["hold"].strip(), "duration": max(0, dur)})
    return out


def parse_profile(obj: Any) -> dict[str, Any] | None:
    """Parse the ``profile`` block of a model entry; None = original behaviour."""
    if not isinstance(obj, dict):
        return None
    power = obj.get("power") if isinstance(obj.get("power"), dict) else {}
    ptype = power.get("type") if power.get("type") in ("discrete", "toggle", "none") else "unknown"
    timing = obj.get("timing") if isinstance(obj.get("timing"), dict) else {}
    reps = timing.get("repeats")
    inputs = {}
    for inp in obj.get("inputs") if isinstance(obj.get("inputs"), list) else []:
        if isinstance(inp, dict):
            name, steps = str(inp.get("name") or "").strip(), parse_steps(inp.get("steps"))
            if name and steps:
                inputs[name] = steps
    return {
        "power": {"type": ptype, **{k: parse_steps(power.get(k)) for k in ("on", "off", "toggle")}},
        "timing": {
            "power_on_delay_ms": _ms(timing, "power_on_delay_ms"),
            "inter_key_delay_ms": _ms(timing, "inter_key_delay_ms"),
            "inter_device_delay_ms": _ms(timing, "inter_device_delay_ms"),
            "input_delay_ms": _ms(timing, "input_delay_ms"),
            "repeats": max(1, min(10, reps)) if isinstance(reps, int) and not isinstance(reps, bool) else 1,
        },
        "inputs": inputs,
    }


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def profile_input(profile: dict[str, Any], name: str) -> list[dict[str, Any]] | None:
    """IrDeviceProfile.input: exact, normalised, or "InputHdmi2" -> "HDMI 2"."""
    inputs = profile.get("inputs") or {}
    if name in inputs:
        return inputs[name]
    for key, steps in inputs.items():
        if _norm(key) == _norm(name):
            return steps
    wanted = _norm(name).removeprefix("input")
    return next((steps for key, steps in inputs.items() if _norm(key) == wanted), None)


# --------------------------------------------------------------------------
# Lookup (upstream IrDatabaseRuntime.modelData / commandCodes)
# --------------------------------------------------------------------------

_HARMONY_SUFFIX = " (harmony)"


def find_model(db: Any, brand: str, model: str) -> dict[str, Any] | None:
    """Brand + model, case-insensitive; also "<model> (Harmony)" both ways."""
    key = model.lower()
    for b in db.get("brands", []) if isinstance(db, dict) else []:
        if str(b.get("brand_name", "")).lower() != brand.lower():
            continue
        models = {str(m.get("model_name", "")).lower(): m for m in b.get("models", []) if isinstance(m, dict)}
        return models.get(key) or models.get(key + _HARMONY_SUFFIX) or models.get(key.removesuffix(_HARMONY_SUFFIX))
    return None


def find_command(commands: dict[str, Any], command: str) -> Any:
    """Exact id, else ignoring case/spaces/_/- (``volume_up`` finds ``VolumeUp``)."""
    if command in commands:
        return commands[command]
    wanted = _norm(command)
    return next((v for k, v in commands.items() if _norm(k) == wanted), None)


async def _model(device: dict[str, Any], fetch_category: Callable[[str], Awaitable[Any]]) -> dict[str, Any] | None:
    category, brand, model = (device.get(k) for k in ("category", "brand", "model"))
    if not (category and brand and model):
        return None
    return find_model(await fetch_category(category), brand, model)


async def device_profile(device: dict[str, Any], fetch_category: Callable[[str], Awaitable[Any]]) -> dict | None:
    """Profile of an ir-database device; None for inline devices / no profile."""
    if "commands" in device:
        return None
    model = await _model(device, fetch_category)
    return parse_profile(model.get("profile")) if model else None


async def has_command(device: dict[str, Any], command: str, fetch_category: Callable[[str], Awaitable[Any]]) -> bool:
    """IrDatabaseRuntime.hasCommand: same lookup as :func:`resolve`, no error."""
    if "commands" in device:
        return command in (device.get("commands") or {})
    model = await _model(device, fetch_category)
    return bool(model and find_command(model.get("commands") or {}, command))


async def resolve(
    device: dict[str, Any],
    command: str,
    fetch_category: Callable[[str], Awaitable[Any]],
) -> dict[str, Any]:
    """Resolve ``command`` of an IR device to ``{"freq", "pattern", "pronto"?}``.

    ``fetch_category`` downloads ``/ir-database/<category>.json`` from the remote.
    Inline commands: exact id (upstream ``source.commands[command]``).
    """
    if "commands" in device:
        step = (device.get("commands") or {}).get(command)
        if not isinstance(step, dict) or not step.get("pattern"):
            raise IRError("ir_command_not_found", f"{device.get('id')}/{command}")
        return step
    if not all(device.get(k) for k in ("category", "brand", "model")):
        raise IRError("ir_command_not_found", f"{device.get('id')}: no source")
    model = await _model(device, fetch_category)
    entry = find_command((model or {}).get("commands") or {}, command)
    if not isinstance(entry, dict) or not entry.get("pronto"):
        raise IRError(
            "ir_command_not_found", f"{device.get('category')}/{device.get('brand')}/{device.get('model')}/{command}"
        )
    rep = (
        entry.get("pronto_repeat")
        if isinstance(entry.get("pronto_repeat"), str) and entry["pronto_repeat"].strip()
        else None
    )
    pronto, rep = repair_split_pronto(entry["pronto"], rep)
    profile = parse_profile(model.get("profile")) if model else None
    pronto = build_repeated_pronto(pronto, rep, profile["timing"]["repeats"] if profile else 1)
    _LOGGER.debug("IR %s/%s resolved (%s)", device.get("id"), command, device.get("category"))
    return {**pronto_to_pattern(pronto), "pronto": pronto}
