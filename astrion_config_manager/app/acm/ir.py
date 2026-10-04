"""IR code resolution and conversion for the HA ``remote.*`` emitter (spec RF6.8).

Sources of an IR command (upstream ``config/DashboardLoader.kt`` and
``config/IrDatabaseRuntime.kt``):

* inline device: ``commands[<id>] = {"freq": Hz, "pattern": [µs, ...]}``;
* ir-database device: ``category``/``brand``/``model`` -> Pronto Hex code in
  ``/ir-database/<category>.json`` on the remote, layout
  ``{brands:[{brand_name, models:[{model_name, commands:{id:{pronto}}}]}]}``,
  matched case-insensitively on brand and model as upstream does.

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


async def resolve(
    device: dict[str, Any],
    command: str,
    fetch_category: Callable[[str], Awaitable[Any]],
) -> dict[str, Any]:
    """Resolve ``command`` of an IR device to ``{"freq", "pattern"}``.

    ``fetch_category`` downloads ``/ir-database/<category>.json`` from the remote.
    """
    if "commands" in device:
        step = (device.get("commands") or {}).get(command)
        if not isinstance(step, dict) or not step.get("pattern"):
            raise IRError("ir_command_not_found", f"{device.get('id')}/{command}")
        return step
    category, brand, model = (device.get(k) for k in ("category", "brand", "model"))
    if not (category and brand and model):
        raise IRError("ir_command_not_found", f"{device.get('id')}: no source")
    db = await fetch_category(category)
    for b in db.get("brands", []):
        if str(b.get("brand_name", "")).lower() != brand.lower():
            continue
        for m in b.get("models", []):
            if str(m.get("model_name", "")).lower() == model.lower():
                entry = (m.get("commands") or {}).get(command)
                if entry and entry.get("pronto"):
                    _LOGGER.debug("IR %s/%s resolved from ir-database %s", device.get("id"), command, category)
                    return pronto_to_pattern(entry["pronto"])
    raise IRError("ir_command_not_found", f"{category}/{brand}/{model}/{command}")
