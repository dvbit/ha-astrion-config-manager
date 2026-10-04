"""Harmony Hub local client (spec RF6.7).

Same protocol as upstream ``harmony/HarmonyHubDiscovery.kt`` and
``harmony/HarmonyHubClient.kt``:

1. hub id: ``POST http://<ip>:8088/`` with
   ``{"id":1,"cmd":"setup.account?getProvisionInfo","params":{}}`` and header
   ``Origin: http://sl.dhg.myharmony.com`` -> ``data.activeRemoteId``;
2. WebSocket ``ws://<ip>:8088/?domain=svcs.myharmony.com&hubId=<id>``;
3. every message is ``{"hubId", "timeout": 30, "hbus": {"cmd", "id", "params"}}``:
   * start Activity: ``harmony.activityengine?runactivity`` ``{"activityId"}``
     (``"-1"`` = PowerOff);
   * device command: ``vnd.logitech.harmony/vnd.logitech.harmony.engine?holdAction``
     ``press`` then, after 120 ms, ``release``; ``action`` is the JSON string
     ``{"type":"IRCommand","deviceId","command"}``.

RF6.7: all Harmony actions go to the single Hub IP configured on the remote;
the per-action ``hub`` field is ignored (decision recorded in SPEC.en.md).
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import time

import aiohttp

_LOGGER = logging.getLogger(__name__)

PORT = 8088
ORIGIN = "http://sl.dhg.myharmony.com"
PRESS_HOLD_DELAY = 0.12  # upstream PRESS_HOLD_DELAY = 120 ms
TIMEOUT = aiohttp.ClientTimeout(total=6, connect=4)


class HarmonyError(Exception):
    """Hub unreachable or protocol failure."""


class HarmonyHub:
    """One connection to one Hub, opened lazily and reused."""

    def __init__(self, session: aiohttp.ClientSession, ip: str, port: int = PORT) -> None:
        """Bind to the Hub at ``ip``."""
        self._session = session
        self.ip = ip
        self._port = port
        self._hub_id: str | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._ids = itertools.count(1)
        self._lock = asyncio.Lock()

    async def _discover(self) -> str:
        url = f"http://{self.ip}:{self._port}/"
        body = {"id": 1, "cmd": "setup.account?getProvisionInfo", "params": {}}
        _LOGGER.debug("Harmony discovery POST %s", url)
        try:
            async with self._session.post(
                url, json=body, headers={"Origin": ORIGIN, "Accept": "text/plain"}, timeout=TIMEOUT
            ) as resp:
                text = await resp.text()
                if resp.status != 200:
                    raise HarmonyError(f"discovery HTTP {resp.status}")
        except (aiohttp.ClientError, TimeoutError) as err:
            raise HarmonyError(f"hub unreachable: {err or type(err).__name__}") from err
        try:
            return str(json.loads(text)["data"]["activeRemoteId"])
        except (ValueError, KeyError, TypeError) as err:
            raise HarmonyError("unexpected discovery reply") from err

    async def _socket(self) -> aiohttp.ClientWebSocketResponse:
        if self._ws is not None and not self._ws.closed:
            return self._ws
        if self._hub_id is None:
            self._hub_id = await self._discover()
            _LOGGER.info("Harmony Hub %s: hub id %s", self.ip, self._hub_id)
        url = f"ws://{self.ip}:{self._port}/?domain=svcs.myharmony.com&hubId={self._hub_id}"
        try:
            self._ws = await self._session.ws_connect(
                url, headers={"Origin": ORIGIN}, timeout=aiohttp.ClientWSTimeout(ws_close=5)
            )
        except (aiohttp.ClientError, TimeoutError) as err:
            raise HarmonyError(f"websocket failed: {err or type(err).__name__}") from err
        _LOGGER.debug("Harmony Hub %s: websocket open", self.ip)
        return self._ws

    async def _send(self, cmd: str, params: dict) -> None:
        async with self._lock:
            ws = await self._socket()
            msg = {
                "hubId": self._hub_id,
                "timeout": 30,
                "hbus": {"cmd": cmd, "id": str(next(self._ids)), "params": params},
            }
            _LOGGER.debug("Harmony send: %s", msg)
            try:
                await ws.send_json(msg)
            except (aiohttp.ClientError, ConnectionError, RuntimeError) as err:
                self._ws = None
                raise HarmonyError(f"send failed: {err}") from err

    async def start_activity(self, activity_id: str) -> None:
        """Run an Activity (``"-1"`` = PowerOff)."""
        await self._send("harmony.activityengine?runactivity", {"activityId": str(activity_id)})
        _LOGGER.info("Harmony %s: start activity %s", self.ip, activity_id)

    async def send_command(self, device_id: str, command: str) -> None:
        """Press + release of one device command (holdAction)."""
        action = json.dumps({"type": "IRCommand", "deviceId": str(device_id), "command": command})
        stamp = str(int(time.time() * 1000))
        cmd = "vnd.logitech.harmony/vnd.logitech.harmony.engine?holdAction"
        await self._send(cmd, {"status": "press", "timestamp": stamp, "verb": "render", "action": action})
        await asyncio.sleep(PRESS_HOLD_DELAY)
        await self._send(cmd, {"status": "release", "timestamp": stamp, "verb": "render", "action": action})
        _LOGGER.info("Harmony %s: command %s/%s", self.ip, device_id, command)

    async def close(self) -> None:
        """Close the websocket if open."""
        if self._ws is not None:
            await self._ws.close()
            self._ws = None


class HarmonyRegistry:
    """One :class:`HarmonyHub` per IP, shared by all remotes."""

    def __init__(self, session: aiohttp.ClientSession, port: int = PORT) -> None:
        """Create an empty registry."""
        self._session = session
        self._port = port
        self._hubs: dict[str, HarmonyHub] = {}

    def get(self, ip: str) -> HarmonyHub:
        """Return (creating if needed) the hub client for ``ip``."""
        if ip not in self._hubs:
            self._hubs[ip] = HarmonyHub(self._session, ip, self._port)
        return self._hubs[ip]

    async def close(self) -> None:
        """Close all hub connections."""
        for hub in self._hubs.values():
            await hub.close()
