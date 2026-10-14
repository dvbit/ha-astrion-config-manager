"""Composed Activity planner (spec RF10.5) - port of upstream ``ActivityPlanner.kt``.

Pure (no I/O): it decides *what* to send to start or stop a composed Activity;
:mod:`acm.actions` sends it.  Kept line-by-line close to the Kotlin original
(astrion-custom-dashboard 1.2.7-beta) so the simulator sends what the remote
would send.

* Harmony-style start, as soon as one IR device of the Activity has an
  ir-database ``profile``: power off the room's devices that are on but not
  used -> power on the ones that are off, staggered by inter-device delays ->
  wait until each is ready (power-on delays overlap) -> select inputs, only
  when they change (named profile inputs run their key sequence).
* No profile: the original per-device order (power on -> input ->
  ``delayAfterMs``); "already on" comes from the device-state memory when known.

Inputs to the planner (all plain data):

* ``profile_of(device_cfg) -> dict | None`` - parsed profile (``acm.ir.parse_profile``);
* ``has_command(device_cfg, command) -> bool``;
* ``states``: device id -> ``{"on": bool|None, "input": str|None}``.

Planned actions: ``{"type": "command"|"ha_power"|"ha_source", "device": cfg,
"command"|"on"|"source": ..., "gap": ms}`` where ``gap`` is the wait before it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .ir import profile_input

# Approximate length of one held-key frame (incl. its gap).
HOLD_FRAME_MS = 110
MAX_HOLD_PRESSES = 50


def _flag(dev: dict[str, Any], key: str, default: bool = True) -> bool:
    """DashboardLoader: ``content.toBooleanStrictOrNull() ?: default`` (bool or "true"/"false")."""
    val = dev.get(key)
    if isinstance(val, bool):
        return val
    if val in ("true", "false"):
        return val == "true"
    return default


def _int(dev: dict[str, Any], key: str) -> int:
    val = dev.get(key)
    return val if isinstance(val, int) and not isinstance(val, bool) else 0


def hold_presses(duration_ms: int) -> int:
    """Return the number of frames sent for a held key."""
    return max(1, min(MAX_HOLD_PRESSES, duration_ms // HOLD_FRAME_MS))


class _Builder:
    """Accumulates actions with their gaps (Kotlin ``ActivityPlanner.Builder``)."""

    def __init__(self, profile_of: Callable[[dict], dict | None]) -> None:
        self.profile_of = profile_of
        self.actions: list[dict[str, Any]] = []
        self.power_changes: dict[str, bool] = {}
        self.input_changes: dict[str, str] = {}
        self.clock_ms = 0
        self._pending = 0

    def gap(self, ms: int) -> None:
        self._pending = max(self._pending, ms)

    def add_delay(self, ms: int) -> None:
        self._pending += ms

    def wait_until(self, until_ms: int) -> None:
        self._pending += max(0, until_ms - (self.clock_ms + self._pending))

    def _take(self) -> int:
        gap, self._pending = self._pending, 0
        self.clock_ms += gap
        return gap

    def emit(self, action: dict[str, Any]) -> None:
        action["gap"] = self._take()
        self.actions.append(action)

    def macro(self, dev: dict[str, Any], steps: list[dict[str, Any]], inter_key_ms: int) -> None:
        first = True
        for step in steps:
            if "delay" in step:
                self.add_delay(step["delay"])
                continue
            if not first:
                self.gap(inter_key_ms)
            if "send" in step:
                self.emit({"type": "command", "device": dev, "command": step["send"]})
            else:  # hold
                for _ in range(hold_presses(step["duration"])):
                    self.emit({"type": "command", "device": dev, "command": step["hold"]})
            first = False

    def power(self, dev: dict[str, Any], on: bool, has_command: Callable[[dict, str], bool]) -> bool:
        if dev.get("source") == "ha":
            self.emit({"type": "ha_power", "device": dev, "on": on})
            sent = True
        else:
            sent = self._ir_power(dev, on, has_command)
        if sent:
            self.power_changes[dev.get("deviceId")] = on
        return sent

    def _ir_power(self, dev: dict[str, Any], on: bool, has_command: Callable[[dict, str], bool]) -> bool:
        profile = self.profile_of(dev)
        cmd = dev.get("powerOnCommand" if on else "powerOffCommand")
        explicit = [{"send": cmd}] if isinstance(cmd, str) and (profile is None or has_command(dev, cmd)) else None
        ptype = profile["power"]["type"] if profile else None
        if ptype == "discrete":
            # An explicit command in the Activity always wins over the profile's own.
            steps = explicit or (profile["power"]["on"] if on else profile["power"]["off"])
        elif ptype == "toggle":
            steps = profile["power"]["toggle"] or (explicit or [])
        elif ptype == "none":
            steps = []
        else:
            steps = explicit or []
        if steps:
            self.macro(dev, steps, profile["timing"]["inter_key_delay_ms"] if profile else 0)
        return bool(steps)

    def input(self, dev: dict[str, Any], name: str) -> None:
        if dev.get("source") == "ha":
            self.emit({"type": "ha_source", "device": dev, "source": name})
        else:
            profile = self.profile_of(dev)
            steps = (profile_input(profile, name) if profile else None) or [{"send": name}]
            self.macro(dev, steps, profile["timing"]["inter_key_delay_ms"] if profile else 0)
        self.input_changes[dev.get("deviceId")] = name

    def build(self) -> dict[str, Any]:
        return {"actions": self.actions, "power": self.power_changes, "inputs": self.input_changes}


class ActivityPlanner:
    """Port of ``ActivityPlanner`` (see module doc)."""

    def __init__(
        self,
        profile_of: Callable[[dict], dict | None],
        states: dict[str, dict[str, Any]],
        has_command: Callable[[dict, str], bool] = lambda d, c: True,
    ) -> None:
        """Bind the per-device profile lookup, the state memory and command check."""
        self.profile_of = profile_of
        self.states = states
        self.has_command = has_command

    # -- helpers -------------------------------------------------------------

    def _state(self, dev_id: str) -> dict[str, Any]:
        return self.states.get(dev_id) or {}

    def _inter_device(self, dev: dict[str, Any]) -> int:
        prof = self.profile_of(dev)
        return prof["timing"]["inter_device_delay_ms"] if prof else 0

    def _is_on(self, dev: dict[str, Any], outgoing: set[str]) -> bool:
        """Known state first; unknown -> "on" only if the outgoing Activity used it."""
        on = self._state(dev.get("deviceId")).get("on")
        return on if on is not None else dev.get("deviceId") in outgoing

    def _needs_power(self, dev: dict[str, Any], outgoing: set[str]) -> bool:
        prof = self.profile_of(dev)
        discrete = bool(prof and prof["power"]["type"] == "discrete")
        return _flag(dev, "powerOnFirst") and (
            not self._is_on(dev, outgoing) or (discrete and dev.get("deviceId") not in outgoing)
        )

    def _needs_input(self, dev: dict[str, Any], name: str, powered_now: bool, outgoing: set[str]) -> bool:
        current = self._state(dev.get("deviceId")).get("input")
        same = isinstance(current, str) and current.lower() == name.lower()
        return powered_now or not same or not self._is_on(dev, outgoing)

    # -- start -----------------------------------------------------------------

    def plan_start(
        self,
        incoming: dict[str, Any],
        room_devices: list[dict[str, Any]],
        outgoing_devices: set[str],
        outgoing_configs: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Plan for starting ``incoming`` (Kotlin ``planStart``)."""
        b = _Builder(self.profile_of)
        devices = [d for d in incoming.get("devices") or [] if isinstance(d, dict)]
        incoming_ids = {d.get("deviceId") for d in devices}
        # 1. Power off what this Activity doesn't use.
        for dev in self._power_off_candidates(room_devices, outgoing_devices, outgoing_configs, incoming_ids):
            if b.power(dev, False, self.has_command):
                b.gap(self._inter_device(dev))
        if not any(self.profile_of(d) for d in devices):
            self._original_start(b, devices, outgoing_devices)
        else:
            ready_at = self._power_on(b, devices, outgoing_devices)
            self._inputs(b, devices, outgoing_devices, ready_at)
        return b.build()

    def _original_start(self, b: _Builder, devices: list[dict[str, Any]], outgoing: set[str]) -> None:
        for idx, dev in enumerate(devices):
            if self._needs_power(dev, outgoing):
                b.power(dev, True, self.has_command)
            if isinstance(dev.get("inputCommand"), str):
                b.input(dev, dev["inputCommand"])
            if idx < len(devices) - 1:
                b.gap(_int(dev, "delayAfterMs"))

    def _power_on(self, b: _Builder, devices: list[dict[str, Any]], outgoing: set[str]) -> dict[str, int]:
        ready_at: dict[str, int] = {}
        for dev in devices:
            was_on = self._is_on(dev, outgoing)
            if self._needs_power(dev, outgoing) and b.power(dev, True, self.has_command):
                prof = self.profile_of(dev)
                timing = prof["timing"] if prof else None
                # A discrete "on" resent to a device believed on is only a safety net.
                if not was_on:
                    delay = timing["power_on_delay_ms"] if timing else _int(dev, "delayAfterMs")
                    ready_at[dev.get("deviceId")] = b.clock_ms + delay
                b.gap(max(timing["inter_device_delay_ms"] if timing else 0, _int(dev, "delayAfterMs")))
        return ready_at

    def _inputs(self, b: _Builder, devices: list[dict[str, Any]], outgoing: set[str], ready_at: dict[str, int]) -> None:
        for dev in devices:
            name = dev.get("inputCommand")
            if isinstance(name, str) and self._needs_input(dev, name, dev.get("deviceId") in ready_at, outgoing):
                if dev.get("deviceId") in ready_at:
                    b.wait_until(ready_at[dev.get("deviceId")])
                b.input(dev, name)
                prof = self.profile_of(dev)
                timing = prof["timing"] if prof else {}
                b.gap(max(timing.get("input_delay_ms", 0), timing.get("inter_device_delay_ms", 0)))

    # -- stop ------------------------------------------------------------------

    def plan_stop(self, activity: dict[str, Any]) -> dict[str, Any]:
        """Plan for stopping ``activity``: power off its devices that may be on."""
        b = _Builder(self.profile_of)
        for dev in activity.get("devices") or []:
            may_be_on = isinstance(dev, dict) and self._state(dev.get("deviceId")).get("on") is not False
            if may_be_on and _flag(dev, "powerOffOnExit") and b.power(dev, False, self.has_command):
                b.gap(self._inter_device(dev))
        return b.build()

    def _power_off_candidates(
        self,
        room_devices: list[dict[str, Any]],
        outgoing: set[str],
        outgoing_configs: list[dict[str, Any]],
        incoming_ids: set[str],
    ) -> list[dict[str, Any]]:
        by_id: dict[str, dict[str, Any]] = {}
        for dev in outgoing_configs + room_devices:
            if isinstance(dev, dict):
                by_id.setdefault(dev.get("deviceId"), dev)
        out_ids = {d.get("deviceId") for d in outgoing_configs if isinstance(d, dict)}
        result = []
        for dev_id, dev in by_id.items():
            if dev_id in incoming_ids or not _flag(dev, "powerOffOnExit"):
                continue
            on = self._state(dev_id).get("on")
            if on is True or (on is None and dev_id in outgoing and dev_id in out_ids):
                result.append(dev)
        return result
