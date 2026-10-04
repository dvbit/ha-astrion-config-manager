"""HTTP client for the Astrion remote's own config page (spec section 3).

The remote exposes no API: the add-on issues the same requests as the
browser on ``http://<host>:<port>``, as implemented upstream in
``app/src/main/java/com/custom/astrion/web/ConfigServer.kt``:

* ``GET  /dashboard.json`` -> 200 with the file, 404 "No dashboard.json yet"
* ``POST /dashboard.json`` -> multipart form, field ``file``; the device
  answers with a redirect to its home page (not followed here).
* ``GET  /ir-database/<category>.json`` -> curated IR codes (used by v2).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import aiohttp

from .canonical import canonical_hash, pretty_dumps

_LOGGER = logging.getLogger(__name__)

TIMEOUT = aiohttp.ClientTimeout(total=10, connect=4)


class DeviceError(Exception):
    """Pull/push failure; ``code`` is translated by the frontend."""

    def __init__(self, code: str, detail: str = "") -> None:
        """Keep a stable error code plus a technical detail."""
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


@dataclass
class Pulled:
    """Result of a pull: parsed JSON and its canonical hash (RF5.2)."""

    content: Any
    hash: str


class DeviceClient:
    """Pull/push ``dashboard.json`` on one remote."""

    def __init__(self, session: aiohttp.ClientSession, host: str, port: int) -> None:
        """Bind the client to ``host:port``."""
        self._session = session
        self._base = f"http://{host}:{port}"

    async def pull(self) -> Pulled:
        """Download and parse ``dashboard.json`` (RF1.2, RF5.1, RF5.2)."""
        url = f"{self._base}/dashboard.json"
        _LOGGER.debug("GET %s", url)
        try:
            async with self._session.get(url, timeout=TIMEOUT) as resp:
                if resp.status == 404:
                    raise DeviceError("file_missing")
                if resp.status != 200:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
                raw = await resp.read()
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err
        try:
            content = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            raise DeviceError("invalid_json", str(err)) from err
        return Pulled(content, canonical_hash(content))

    async def upload(self, content: Any) -> None:
        """Upload ``content`` the same way the device's own form does (RF5.4)."""
        url = f"{self._base}/dashboard.json"
        form = aiohttp.FormData()
        form.add_field(
            "file",
            pretty_dumps(content).encode("utf-8"),
            filename="dashboard.json",
            content_type="application/json",
        )
        _LOGGER.debug("POST %s", url)
        try:
            async with self._session.post(url, data=form, timeout=TIMEOUT, allow_redirects=False) as resp:
                # Success is a redirect back to the config home page.
                if resp.status >= 400:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err
