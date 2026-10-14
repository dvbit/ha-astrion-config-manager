"""Real execution of simulator actions (spec RF6.5, RF6.7, RF6.8, RF6.9).

The frontend turns a tap / physical key into a list of normalised steps,
mirroring upstream ``ButtonGridCard.fire``, ``SceneGridCard``, the card
renderers and ``MainActivity.runHotkey``.  Navigation (pages, popups) stays in
the simulator (RF6.6); everything else is executed here for real:

* ``{"kind": "service", "service": "d.s", "entity_id"?, "data"?}``   -> HA (RF6.5)
* ``{"kind": "harmony_command", "device", "command", "hub"?}``      -> Hub (RF6.7, RF8.2)
* ``{"kind": "harmony_activity", "activity", "hub"?}``               -> Hub (RF6.7, RF8.2)
* ``{"kind": "ir", "device", "command"}``  -> by the IR device ``target``:
  ``local`` -> the remote's ``remote.*`` entity (RF6.8), ``{"extender": id}``
  -> that extender over HTTP (RF8.4)
* ``{"kind": "activity", "id"}`` composed Activity start   (ActivityDispatcher.switchActivity)
* ``{"kind": "activity_stop", "room"}`` stop a room, ``"*"`` = all (stopActivities, RF10.3)
* ``{"kind": "track", "room", "id", "harmony"?, "hub"?, "devices"?}`` tracked tile
  (ActivityRuntime.trackTap)
* ``{"kind": "event", "event", "key", "long", "page"}`` hotkey HA event (RF10.7)

Device-state memory (DeviceStateStore / ActiveActivityStore, RF10.5) is kept
per remote in ``<data>/sim_state/<remote>.json``: it is the simulator's own
belief about what it has sent, independent of the remote's (not exposed).

Steps run in order; a failing step does not stop the others (as upstream,
where each action fires independently).  Each result is reported (RF6.5).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

from .device import DeviceClient, DeviceError
from .extender import ExtenderError, send_pronto
from .ha import HAClient, HAError
from .harmony import HarmonyError, HarmonyRegistry
from .ir import IRError, device_profile, has_command, pattern_to_pronto, resolve, to_b64_command
from .planner import ActivityPlanner
from .store import atomic_write

_LOGGER = logging.getLogger(__name__)

# Safety cap for one wait (upstream TimingProfile caps every delay at 60 s).
MAX_DELAY_S = 60.0
# MainActivity.BUTTON_EVENT (1.2.7-beta)
BUTTON_EVENT = "astrion_button"
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

    def __init__(
        self, ha: HAClient, harmony: HarmonyRegistry, device_factory, http, data_dir: Path | None = None
    ) -> None:
        """Wire the HA client, Harmony registry, device client factory and state dir."""
        self._ha = ha
        self._harmony = harmony
        self._device_factory = device_factory
        self._http = http
        self._dir = Path(data_dir) / "sim_state" if data_dir else None
        # remote id -> {"devices": {id: {on, input}}, "active": {room: id}, "tracked": {room: {...}}}
        self._states: dict[str, dict[str, Any]] = {}
        self._irdb: dict[tuple[str, str], tuple[float, Any]] = {}

    # -- state memory (RF10.5) --------------------------------------------

    def state(self, rid: str) -> dict[str, Any]:
        """Return the simulator state of one remote, loaded lazily from disk."""
        if rid not in self._states:
            data: dict[str, Any] = {}
            path = self._dir / f"{rid}.json" if self._dir else None
            if path and path.is_file():
                try:
                    data = json.loads(path.read_text("utf-8"))
                except (OSError, ValueError):
                    _LOGGER.warning("Simulator state of %s unreadable: starting empty", rid)
            self._states[rid] = {
                k: data.get(k) if isinstance(data.get(k), dict) else {} for k in ("devices", "active", "tracked")
            }
        return self._states[rid]

    @property
    def active(self) -> dict[str, dict[str, str]]:
        """Room -> active Activity id, per remote (read by the API)."""
        return {rid: st["active"] for rid, st in self._states.items()}

    def _save(self, rid: str) -> None:
        if self._dir:
            atomic_write(self._dir / f"{rid}.json", json.dumps(self._states[rid], ensure_ascii=False).encode("utf-8"))

    def reset(self, rid: str) -> None:
        """'Reset device states': forget every belief and the active Activities."""
        self._states[rid] = {"devices": {}, "active": {}, "tracked": {}}
        self._save(rid)
        _LOGGER.info("Simulator device states of %s reset", rid)

    def _fetcher(self, meta: dict[str, Any]):
        """Return a cached downloader of the remote's ir-database category files."""

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

        return fetch

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
        st = self.state(meta["id"])
        return {"results": results, "active": dict(st["active"]), "devices": dict(st["devices"])}

    # -- dispatch ---------------------------------------------------------

    async def _step(self, meta: dict[str, Any], doc: Any, step: dict[str, Any]) -> None:
        kind = step.get("kind")
        if kind == "service":
            await self._service(step.get("service"), step.get("entity_id"), step.get("data"), meta)
        elif kind == "harmony_command":
            await self._harmony_cmd(meta, step.get("device"), step.get("command"), step.get("hub"))
        elif kind == "harmony_activity":
            hub, label = self._hub(meta, step.get("hub"))
            try:
                await hub.start_activity(str(step.get("activity")))
            except HarmonyError as err:
                raise StepError("harmony_error", f"{label}: {err}") from err
        elif kind == "ir":
            await self._ir(meta, doc, step.get("device"), step.get("command"))
        elif kind == "activity":
            await self._activity_start(meta, doc, str(step.get("id")))
        elif kind == "activity_stop":
            await self._activity_stop(meta, doc, str(step.get("room")))
        elif kind == "track":
            self._track(meta, step)
        elif kind == "event":
            await self._event(meta, step)
        else:
            raise StepError("step_unknown", str(kind))

    async def _service(self, service: Any, entity_id: Any, data: Any, meta: dict[str, Any] | None = None) -> None:
        if not isinstance(service, str) or "." not in service:
            raise StepError("service_invalid", str(service))
        domain, svc = service.split(".", 1)
        tv_entities = {tv.get("entityId") for tv in (meta or {}).get("apple_tvs") or []}
        if domain == "astrion_appletv" or (isinstance(entity_id, str) and entity_id in tv_entities):
            # RF9.5: direct Apple TV control lives on the remote (Companion
            # protocol + pairing keys). Upstream AppleTvRegistry.handle consumes
            # every call on a paired TV's entity locally - HA does not know it.
            raise StepError("appletv_direct", str(entity_id or ""))
        try:
            await self._ha.call_service(domain, svc, entity_id or None, data if isinstance(data, dict) else None)
        except HAError as err:
            raise StepError("ha_error", str(err)) from err

    def _hub(self, meta: dict[str, Any], local_id: Any = None):
        """RF8.2: hub by ``localId``, else the first; RF8.3 fallback IP; else disabled.

        Returns (client, label) where label names the hub for error messages.
        """
        hubs = [h for h in (meta.get("harmony_hubs") or []) if h.get("ip")]
        if hubs:
            hub = next((h for h in hubs if h.get("localId") == local_id), hubs[0])
            return self._harmony.get(hub["ip"], hub.get("hubId")), hub.get("name") or hub["ip"]
        if meta.get("harmony_ip"):
            return self._harmony.get(meta["harmony_ip"]), meta["harmony_ip"]
        raise StepError("harmony_not_configured")

    async def _harmony_cmd(self, meta: dict[str, Any], device: Any, command: Any, hub_id: Any = None) -> None:
        hub, label = self._hub(meta, hub_id)
        try:
            await hub.send_command(str(device), str(command))
        except HarmonyError as err:
            raise StepError("harmony_error", f"{label}: {err}") from err

    async def _ir(self, meta: dict[str, Any], doc: Any, device_id: Any, command: Any) -> None:
        """RF6.8 / RF8.4: route by the IR device target (local or extender)."""
        devices = {d.get("id"): d for d in (doc.get("irDevices") or []) if isinstance(d, dict)}
        device = devices.get(device_id)
        if device is None:
            raise StepError("ir_device_unknown", str(device_id))
        target = device.get("target")
        extender_id = target.get("extender") if isinstance(target, dict) else None
        entity = meta.get("ir_entity")
        if extender_id is None and not entity:
            raise StepError("ir_not_configured")
        extender = None
        if extender_id is not None:
            extender = next((e for e in (meta.get("extenders") or []) if e.get("localId") == extender_id), None)
            if extender is None or not extender.get("host"):
                raise StepError("ir_extender_unknown", str(extender_id))

        fetch = self._fetcher(meta)
        try:
            step = await resolve(device, str(command), fetch)
            if extender is not None:
                # RF8.5: ir-database Pronto as is; inline codes converted
                pronto = step.get("pronto") or pattern_to_pronto(int(step.get("freq") or 38000), step["pattern"])
            else:
                code = to_b64_command(step)
        except IRError as err:
            raise StepError(err.code, err.detail) from err
        if extender is not None:
            label = extender.get("name") or extender["host"]
            try:
                await send_pronto(self._http, extender["host"], pronto)
            except ExtenderError as err:
                raise StepError("extender_error", f"{label}: {err}") from err
            _LOGGER.info("IR %s/%s sent via extender %s", device_id, command, label)
            return
        try:
            await self._ha.call_service("remote", "send_command", entity, {"command": code})
        except HAError as err:
            raise StepError("ha_error", str(err)) from err

    # -- composed Activities (upstream ActivityDispatcher 1.2.7, RF10.5) -----

    @staticmethod
    def _activities(doc: Any) -> dict[str, dict[str, Any]]:
        return {a.get("id"): a for a in (doc.get("activities") or []) if isinstance(a, dict)}

    async def _planner(self, meta: dict[str, Any], doc: Any, devices: list[dict[str, Any]]) -> ActivityPlanner:
        """Planner with the ir-database profiles / command checks pre-fetched."""
        ir_devs = {d.get("id"): d for d in (doc.get("irDevices") or []) if isinstance(d, dict)}
        fetch = self._fetcher(meta)
        profiles: dict[str, dict | None] = {}
        known: dict[tuple[str, str], bool] = {}
        for dev in devices:
            dev_id = dev.get("deviceId")
            if dev.get("source") != "ir" or dev_id not in ir_devs:
                continue
            try:
                profiles[dev_id] = await device_profile(ir_devs[dev_id], fetch)
                for key in ("powerOnCommand", "powerOffCommand"):
                    if isinstance(dev.get(key), str):
                        known[(dev_id, dev[key])] = await has_command(ir_devs[dev_id], dev[key], fetch)
            except StepError:
                profiles[dev_id] = None  # ir-database unreadable: original behaviour
        return ActivityPlanner(
            profile_of=lambda d: profiles.get(d.get("deviceId")) if d.get("source") == "ir" else None,
            states=self.state(meta["id"])["devices"],
            has_command=lambda d, c: d.get("source") != "ir" or known.get((d.get("deviceId"), c), False),
        )

    async def _execute(self, meta: dict[str, Any], doc: Any, plan: dict[str, Any]) -> list[str]:
        """Send a plan (ActivityDispatcher.runSteps), then record device states.

        Consecutive IR commands to the same extender are merged into one
        ``POST /pronto`` batch whose lines carry their own ``delay>`` prefix,
        exactly as upstream ``runExtenderRun``; everything else waits for real.
        """
        errors: list[str] = []
        actions = plan["actions"]
        idx = 0
        while idx < len(actions):
            act = actions[idx]
            ext = await self._extender_target(meta, doc, act)
            if ext is not None:
                batch: list[tuple[int, str]] = []
                while idx < len(actions):
                    cur = actions[idx]
                    if await self._extender_target(meta, doc, cur) != ext:
                        break
                    try:
                        batch.append((cur["gap"], await self._pronto_for(meta, doc, cur)))
                    except StepError as err:
                        errors.append(f"{err.code} {err.detail}".strip())
                        if cur["gap"] and batch:  # keep the wait (it may be a power-on delay)
                            batch[-1] = (batch[-1][0] + cur["gap"], batch[-1][1])
                    idx += 1
                if batch:
                    await self._safe(self._send_batch(meta, ext, batch), errors)
                    total = sum(gap for gap, _ in batch)
                    if idx < len(actions) and total > 0:
                        await asyncio.sleep(min(total / 1000, MAX_DELAY_S))
                continue
            if act["gap"] > 0:
                await asyncio.sleep(min(act["gap"] / 1000, MAX_DELAY_S))
            await self._safe(self._send_action(meta, doc, act), errors)
            idx += 1
        devices = self.state(meta["id"])["devices"]
        for dev_id, on in plan["power"].items():
            devices.setdefault(dev_id, {})["on"] = on
        for dev_id, name in plan["inputs"].items():
            devices.setdefault(dev_id, {})["input"] = name
        self._save(meta["id"])
        return errors

    async def _extender_target(self, meta: dict[str, Any], doc: Any, act: dict[str, Any]) -> str | None:
        """Return the extender localId when ``act`` is an IR command bound to one."""
        dev = act["device"]
        if act["type"] != "command" or dev.get("source") != "ir":
            return None
        ir_dev = next(
            (d for d in doc.get("irDevices") or [] if isinstance(d, dict) and d.get("id") == dev.get("deviceId")), None
        )
        target = (ir_dev or {}).get("target")
        return target.get("extender") if isinstance(target, dict) else None

    async def _pronto_for(self, meta: dict[str, Any], doc: Any, act: dict[str, Any]) -> str:
        ir_dev = next(
            (
                d
                for d in doc.get("irDevices") or []
                if isinstance(d, dict) and d.get("id") == act["device"].get("deviceId")
            ),
            None,
        )
        try:
            step = await resolve(ir_dev, act["command"], self._fetcher(meta))
            return step.get("pronto") or pattern_to_pronto(int(step.get("freq") or 38000), step["pattern"])
        except IRError as err:
            raise StepError(err.code, err.detail) from err

    async def _send_batch(self, meta: dict[str, Any], ext_id: str, batch: list[tuple[int, str]]) -> None:
        ext = next((e for e in meta.get("extenders") or [] if e.get("localId") == ext_id), None)
        if ext is None or not ext.get("host"):
            raise StepError("ir_extender_unknown", ext_id)
        body = "\n".join(f"{gap}>{code}" if gap > 0 else code for gap, code in batch)
        try:
            await send_pronto(self._http, ext["host"], body)
        except ExtenderError as err:
            raise StepError("extender_error", f"{ext.get('name') or ext['host']}: {err}") from err
        _LOGGER.info("Activity: %s command(s) sent in one batch via extender %s", len(batch), ext.get("name"))

    async def _send_action(self, meta: dict[str, Any], doc: Any, act: dict[str, Any]) -> None:
        dev = act["device"]
        dev_id = str(dev.get("deviceId"))
        if act["type"] == "ha_power":
            await self._service(f"{dev_id.split('.')[0]}.{'turn_on' if act['on'] else 'turn_off'}", dev_id, None, meta)
        elif act["type"] == "ha_source":
            await self._service(f"{dev_id.split('.')[0]}.select_source", dev_id, {"source": act["source"]}, meta)
        elif dev.get("source") == "ir":
            await self._ir(meta, doc, dev_id, act["command"])
        elif dev.get("source") == "harmony":
            await self._harmony_cmd(meta, dev_id, act["command"], dev.get("hub"))
        else:
            raise StepError("activity_source_invalid", str(dev.get("source")))

    async def _safe(self, coro, errors: list[str]) -> None:
        """Run one Activity step; collect the error and continue."""
        try:
            await coro
        except StepError as err:
            errors.append(f"{err.code} {err.detail}".strip())

    async def _activity_start(self, meta: dict[str, Any], doc: Any, activity_id: str) -> None:
        """ActivityDispatcher.switchActivity: plan with ActivityPlanner, send, mark active."""
        acts = self._activities(doc)
        act = acts.get(activity_id)
        if act is None:
            raise StepError("activity_unknown", activity_id)
        room = act.get("room")
        st = self.state(meta["id"])
        out_id = st["active"].get(room)
        out_composed = acts.get(out_id) if out_id else None
        # outgoing device ids: composed Activity devices, or a tracked tile's "devices" hint
        out_devices = (
            {d.get("deviceId") for d in out_composed.get("devices") or [] if isinstance(d, dict)}
            if out_composed
            else set((st["tracked"].get(room) or {}).get("devices") or [])
        )
        room_devices = [
            d for a in acts.values() if a.get("room") == room for d in a.get("devices") or [] if isinstance(d, dict)
        ]
        planner = await self._planner(
            meta, doc, room_devices + [d for d in act.get("devices") or [] if isinstance(d, dict)]
        )
        plan = planner.plan_start(act, room_devices, out_devices, (out_composed or {}).get("devices") or [])
        errors = await self._execute(meta, doc, plan)
        st["active"][room] = activity_id
        st["tracked"].pop(room, None)
        self._save(meta["id"])
        _LOGGER.info(
            "Activity '%s' started on '%s' (room %s, %s action(s))",
            activity_id,
            meta["name"],
            room,
            len(plan["actions"]),
        )
        if errors:
            raise StepError("activity_partial", "; ".join(errors))

    async def _activity_stop(self, meta: dict[str, Any], doc: Any, room: str) -> None:
        """ActivityDispatcher.stopActivities: one room, or ``"*"`` = every running one."""
        st = self.state(meta["id"])
        rooms = [r for r, a in st["active"].items() if a] if room.strip() == "*" else [room.strip()]
        errors: list[str] = []
        for rm in rooms:
            act = self._activities(doc).get(st["active"].get(rm))
            tracked = st["tracked"].get(rm) or {}
            if act:
                planner = await self._planner(meta, doc, [d for d in act.get("devices") or [] if isinstance(d, dict)])
                errors += await self._execute(meta, doc, planner.plan_stop(act))
                st["active"].pop(rm, None)
            elif tracked.get("harmony"):
                # Harmony has no "stop this Activity": PowerOff on that Activity's own hub.
                try:
                    hub, label = self._hub(meta, tracked.get("hub"))
                    await hub.start_activity("-1")
                    _LOGGER.info("Room %s: Harmony PowerOff on %s", rm, label)
                except (StepError, HarmonyError) as err:
                    errors.append(f"harmony_error {err}")
                hub_id = tracked.get("hub")
                for other, info in list(st["tracked"].items()):  # the hub's rooms are off now
                    if info.get("harmony") and info.get("hub") == hub_id:
                        st["active"].pop(other, None)
                        st["tracked"].pop(other, None)
            else:
                st["active"].pop(rm, None)
            st["tracked"].pop(rm, None)
        self._save(meta["id"])
        _LOGGER.info("Activity stop '%s' on '%s'", room, meta["name"])
        if errors:
            raise StepError("activity_partial", "; ".join(errors))

    def _track(self, meta: dict[str, Any], step: dict[str, Any]) -> None:
        """ActivityRuntime.trackTap: a ``track``+``room`` tile marks its room active."""
        room = str(step.get("room") or "").strip()
        if not room:
            return
        st = self.state(meta["id"])
        st["active"][room] = str(step.get("id"))
        st["tracked"][room] = {
            "harmony": step.get("harmony"),
            "hub": step.get("hub"),
            "devices": [d for d in step.get("devices") or [] if isinstance(d, str)],
        }
        self._save(meta["id"])

    async def _event(self, meta: dict[str, Any], step: dict[str, Any]) -> None:
        """RF10.7: hotkey ``event`` -> ``astrion_button`` on HA's bus (MainActivity.fireEventHotkey)."""
        ident = meta.get("identity") or {}
        data: dict[str, Any] = {}
        if ident.get("id"):
            data["remote_id"] = ident["id"]
        if ident.get("name"):
            data["remote_name"] = ident["name"]
        data.update(
            {
                "event": str(step.get("event")),
                "key": str(step.get("key") or "").upper(),
                "long": bool(step.get("long")),
                "page": str(step.get("page") or ""),
            }
        )
        try:
            await self._ha.fire_event(BUTTON_EVENT, data)
        except HAError as err:
            raise StepError("ha_error", str(err)) from err
