"""Real execution of simulator actions (spec RF6.5, RF6.7, RF6.8, RF6.9).

The frontend turns a tap / physical key into a list of normalised steps,
mirroring upstream ``ButtonGridCard.fire``, ``SceneGridCard``, the card
renderers and ``MainActivity.runHotkey``.  Navigation (pages, popups) stays in
the simulator (RF6.6); everything else is executed here for real:

* ``{"kind": "service", "service": "d.s", "entity_id"?, "data"?}``   -> HA (RF6.5)
* ``{"kind": "harmony_command", "device", "command"}``               -> Hub (RF6.7)
* ``{"kind": "harmony_activity", "activity"}``                       -> Hub (RF6.7)
* ``{"kind": "ir", "device", "command"}``                            -> remote.* (RF6.8)
* ``{"kind": "activity", "id"}`` composed Activity start   (ActivityDispatcher.switchActivity)
* ``{"kind": "activity_stop", "room"}`` composed Activity stop (ActivityDispatcher.stopActivity)

Steps run in order; a failing step does not stop the others (as upstream,
where each action fires independently).  Each result is reported (RF6.5).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .device import DeviceClient, DeviceError
from .ha import HAClient, HAError
from .harmony import HarmonyError, HarmonyRegistry
from .ir import IRError, resolve, to_b64_command

_LOGGER = logging.getLogger(__name__)

# Safety cap for an Activity device's delayAfterMs.
MAX_DELAY_S = 30.0
# ir-database category files are cached for this long.
IRDB_TTL = 300.0


class StepError(Exception):
    """A step that cannot run; ``code`` translated by the frontend."""

    def __init__(self, code: str, detail: str = "") -> None:
        """Keep code + detail."""
        super().__init__(code)
        self.code = code
        self.detail = detail


class Executor:
    """Executes steps for one remote; keeps the composed Activity runtime."""

    def __init__(self, ha: HAClient, harmony: HarmonyRegistry, device_factory, http) -> None:
        """Wire the HA client, Harmony registry and device client factory."""
        self._ha = ha
        self._harmony = harmony
        self._device_factory = device_factory
        self._http = http
        # remote id -> room -> active composed Activity id (ActivityRuntime)
        self.active: dict[str, dict[str, str]] = {}
        self._irdb: dict[tuple[str, str], tuple[float, Any]] = {}

    # -- public -----------------------------------------------------------

    async def run(self, meta: dict[str, Any], doc: Any, steps: list[dict[str, Any]]) -> dict[str, Any]:
        """Run ``steps``; return per-step results and the Activity runtime."""
        results = []
        for step in steps:
            kind = step.get("kind")
            try:
                await self._step(meta, doc, step)
                results.append({"kind": kind, "ok": True})
            except StepError as err:
                _LOGGER.warning("Simulator step %s on '%s' failed: %s %s", kind, meta["name"], err.code, err.detail)
                results.append({"kind": kind, "ok": False, "error": err.code, "detail": err.detail})
        return {"results": results, "active": dict(self.active.get(meta["id"], {}))}

    # -- dispatch ---------------------------------------------------------

    async def _step(self, meta: dict[str, Any], doc: Any, step: dict[str, Any]) -> None:
        kind = step.get("kind")
        if kind == "service":
            await self._service(step.get("service"), step.get("entity_id"), step.get("data"))
        elif kind == "harmony_command":
            await self._harmony_cmd(meta, step.get("device"), step.get("command"))
        elif kind == "harmony_activity":
            hub = self._hub(meta)
            try:
                await hub.start_activity(str(step.get("activity")))
            except HarmonyError as err:
                raise StepError("harmony_error", str(err)) from err
        elif kind == "ir":
            await self._ir(meta, doc, step.get("device"), step.get("command"))
        elif kind == "activity":
            await self._activity_start(meta, doc, str(step.get("id")))
        elif kind == "activity_stop":
            await self._activity_stop(meta, doc, str(step.get("room")))
        else:
            raise StepError("step_unknown", str(kind))

    async def _service(self, service: Any, entity_id: Any, data: Any) -> None:
        if not isinstance(service, str) or "." not in service:
            raise StepError("service_invalid", str(service))
        domain, svc = service.split(".", 1)
        try:
            await self._ha.call_service(domain, svc, entity_id or None, data if isinstance(data, dict) else None)
        except HAError as err:
            raise StepError("ha_error", str(err)) from err

    def _hub(self, meta: dict[str, Any]):
        """RF6.7: single Hub IP of the remote, otherwise disabled."""
        if not meta.get("harmony_ip"):
            raise StepError("harmony_not_configured")
        return self._harmony.get(meta["harmony_ip"])

    async def _harmony_cmd(self, meta: dict[str, Any], device: Any, command: Any) -> None:
        hub = self._hub(meta)
        try:
            await hub.send_command(str(device), str(command))
        except HarmonyError as err:
            raise StepError("harmony_error", str(err)) from err

    async def _ir(self, meta: dict[str, Any], doc: Any, device_id: Any, command: Any) -> None:
        """RF6.8: resolve, convert to Broadlink b64 and send via remote.*."""
        entity = meta.get("ir_entity")
        if not entity:
            raise StepError("ir_not_configured")
        devices = {d.get("id"): d for d in (doc.get("irDevices") or []) if isinstance(d, dict)}
        device = devices.get(device_id)
        if device is None:
            raise StepError("ir_device_unknown", str(device_id))

        async def fetch(category: str) -> Any:
            key = (meta["id"], category)
            cached = self._irdb.get(key)
            if cached and time.monotonic() - cached[0] < IRDB_TTL:
                return cached[1]
            client: DeviceClient = self._device_factory(self._http, meta["host"], meta["port"])
            try:
                data = await client.ir_category(category)
            except DeviceError as err:
                raise StepError("ir_db_unavailable", err.code) from err
            self._irdb[key] = (time.monotonic(), data)
            return data

        try:
            code = to_b64_command(await resolve(device, str(command), fetch))
        except IRError as err:
            raise StepError(err.code, err.detail) from err
        try:
            await self._ha.call_service("remote", "send_command", entity, {"command": code})
        except HAError as err:
            raise StepError("ha_error", str(err)) from err

    # -- composed Activities (upstream ActivityDispatcher) -------------------

    @staticmethod
    def _activities(doc: Any) -> dict[str, dict[str, Any]]:
        return {a.get("id"): a for a in (doc.get("activities") or []) if isinstance(a, dict)}

    async def _device_power(self, meta, doc, dev: dict[str, Any], on: bool) -> None:
        if dev.get("source") == "ha":
            entity = str(dev.get("deviceId"))
            await self._service(f"{entity.split('.')[0]}.{'turn_on' if on else 'turn_off'}", entity, None)
        else:
            await self._device_command(meta, doc, dev, dev.get("powerOnCommand" if on else "powerOffCommand"))

    async def _device_command(self, meta, doc, dev: dict[str, Any], command: Any) -> None:
        if command is None:
            return
        source, dev_id = dev.get("source"), dev.get("deviceId")
        if source == "ir":
            await self._ir(meta, doc, dev_id, command)
        elif source == "harmony":
            await self._harmony_cmd(meta, dev_id, command)
        elif source == "ha":
            entity = str(dev_id)
            await self._service(f"{entity.split('.')[0]}.select_source", entity, {"source": command})

    async def _safe(self, coro, errors: list[str]) -> None:
        """Run one Activity step; collect the error and continue."""
        try:
            await coro
        except StepError as err:
            errors.append(f"{err.code} {err.detail}".strip())

    async def _activity_start(self, meta: dict[str, Any], doc: Any, activity_id: str) -> None:
        acts = self._activities(doc)
        act = acts.get(activity_id)
        if act is None:
            raise StepError("activity_unknown", activity_id)
        room = act.get("room")
        runtime = self.active.setdefault(meta["id"], {})
        outgoing = acts.get(runtime.get(room)) if runtime.get(room) else None
        incoming_ids = {d.get("deviceId") for d in act.get("devices", [])}
        outgoing_ids = {d.get("deviceId") for d in (outgoing or {}).get("devices", [])}
        errors: list[str] = []
        for dev in (outgoing or {}).get("devices", []):
            if dev.get("deviceId") not in incoming_ids and dev.get("powerOffOnExit", True) is not False:
                await self._safe(self._device_power(meta, doc, dev, False), errors)
        devices = act.get("devices", [])
        for idx, dev in enumerate(devices):
            if dev.get("deviceId") not in outgoing_ids and dev.get("powerOnFirst", True) is not False:
                await self._safe(self._device_power(meta, doc, dev, True), errors)
            await self._safe(self._device_command(meta, doc, dev, dev.get("inputCommand")), errors)
            if idx < len(devices) - 1 and isinstance(dev.get("delayAfterMs"), int) and dev["delayAfterMs"] > 0:
                await asyncio.sleep(min(dev["delayAfterMs"] / 1000, MAX_DELAY_S))
        runtime[room] = activity_id
        _LOGGER.info("Activity '%s' started on '%s' (room %s)", activity_id, meta["name"], room)
        if errors:
            raise StepError("activity_partial", "; ".join(errors))

    async def _activity_stop(self, meta: dict[str, Any], doc: Any, room: str) -> None:
        runtime = self.active.setdefault(meta["id"], {})
        act = self._activities(doc).get(runtime.get(room))
        errors: list[str] = []
        if act:
            for dev in act.get("devices", []):
                if dev.get("powerOffOnExit", True) is not False:
                    await self._safe(self._device_power(meta, doc, dev, False), errors)
        runtime.pop(room, None)
        _LOGGER.info("Activity in room %s stopped on '%s'", room, meta["name"])
        if errors:
            raise StepError("activity_partial", "; ".join(errors))
