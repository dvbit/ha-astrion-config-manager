"""Home Assistant WebSocket client (spec section 3).

Uses the Supervisor proxy ``ws://supervisor/core/websocket`` with the
add-on's ``SUPERVISOR_TOKEN`` (``homeassistant_api: true`` in config.yaml);
the user never enters a token.  Outside the Supervisor (development) the
``HA_WS_URL`` / ``HA_TOKEN`` environment variables are used instead.

v1.0 only needs the list of existing entity ids (RF4.2).  Live state for the
simulator (RF6.4) is planned for v2.0.
"""

from __future__ import annotations

import logging
import os
import time

import aiohttp

_LOGGER = logging.getLogger(__name__)

# Entity list cache, so validation on every edit (RF4.4) stays cheap.
CACHE_TTL = 10.0


class HAError(Exception):
    """Home Assistant could not be queried."""


class HAClient:
    """Minimal request/response WebSocket client."""

    def __init__(self, session: aiohttp.ClientSession) -> None:
        """Read connection settings from the environment."""
        self._session = session
        self._url = os.environ.get("HA_WS_URL", "ws://supervisor/core/websocket")
        self._token = os.environ.get("HA_TOKEN") or os.environ.get("SUPERVISOR_TOKEN", "")
        self._entities: set[str] | None = None
        self._fetched = 0.0

    async def _call(self, payload: dict) -> object:
        """Open a socket, authenticate, run one command, close."""
        if not self._token:
            raise HAError("no token (SUPERVISOR_TOKEN missing)")
        try:
            async with self._session.ws_connect(self._url, timeout=aiohttp.ClientWSTimeout(ws_close=5)) as ws:
                hello = await ws.receive_json(timeout=10)
                if hello.get("type") != "auth_required":
                    raise HAError(f"unexpected handshake: {hello.get('type')}")
                await ws.send_json({"type": "auth", "access_token": self._token})
                auth = await ws.receive_json(timeout=10)
                if auth.get("type") != "auth_ok":
                    raise HAError(f"authentication failed: {auth.get('message', auth.get('type'))}")
                await ws.send_json({"id": 1, **payload})
                while True:
                    msg = await ws.receive_json(timeout=15)
                    if msg.get("id") == 1 and msg.get("type") == "result":
                        if not msg.get("success"):
                            raise HAError(str(msg.get("error")))
                        return msg.get("result")
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise HAError(str(err) or type(err).__name__) from err

    async def entity_ids(self, force: bool = False) -> set[str]:
        """Return all entity ids currently known to HA (cached)."""
        now = time.monotonic()
        if not force and self._entities is not None and now - self._fetched < CACHE_TTL:
            return self._entities
        states = await self._call({"type": "get_states"})
        self._entities = {s["entity_id"] for s in states}  # type: ignore[union-attr]
        self._fetched = now
        _LOGGER.debug("Fetched %s entity ids from HA", len(self._entities))
        return self._entities
