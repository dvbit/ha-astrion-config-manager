"""HTTP client for the Astrion remote's own config page (spec section 3).

The remote exposes no API: the add-on issues the same requests as the
browser on ``http://<host>:<port>``, as implemented upstream in
``app/src/main/java/com/custom/astrion/web/ConfigServer.kt``:

* ``GET  /dashboard.json`` -> 200 with the file, 404 "No dashboard.json yet"
* ``POST /dashboard.json`` -> multipart form, field ``file``; the device
  answers with a redirect to its home page (not followed here).
* ``GET  /ir-database/<category>.json`` -> curated IR codes (RF6.8);
* ``GET  /icons-list`` -> JSON array of icon file names (RF7);
* ``POST /icons`` multipart field ``file`` -> store icon (redirect on success);
* ``GET  /icons/<name>`` -> icon bytes;
* ``GET  /devices-config`` -> remote settings: ``harmonyHubs`` [{localId, name,
  ip, hubId}], ``extenders`` [{localId, name, host, mac}] and ``ha`` (URL and
  token).  Only hubs and extenders are kept (RF8.1): the ``ha`` block, which
  holds the remote's HA token, is discarded and never stored or logged.
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

    async def ir_category(self, category: str) -> Any:
        """Download ``/ir-database/<category>.json`` (curated Pronto codes, RF6.8)."""
        from urllib.parse import quote

        url = f"{self._base}/ir-database/{quote(category)}.json"
        _LOGGER.debug("GET %s", url)
        try:
            async with self._session.get(url, timeout=TIMEOUT) as resp:
                if resp.status != 200:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
                return json.loads((await resp.read()).decode("utf-8"))
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            raise DeviceError("invalid_json", str(err)) from err

    async def devices_config(self) -> dict[str, list[dict[str, str]]]:
        """RF8.1: Harmony hubs and IR extenders configured on the remote."""
        url = f"{self._base}/devices-config"
        try:
            async with self._session.get(url, timeout=TIMEOUT) as resp:
                if resp.status != 200:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
                raw = json.loads((await resp.read()).decode("utf-8"))
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            raise DeviceError("invalid_json", str(err)) from err

        def keep(items: Any, keys: tuple[str, ...]) -> list[dict[str, str]]:
            # whitelist: nothing but the listed keys survives (no token)
            return [
                {k: str(i.get(k) or "") for k in keys}
                for i in (items if isinstance(items, list) else [])
                if isinstance(i, dict) and i.get("localId")
            ]

        return {
            "harmony_hubs": keep(raw.get("harmonyHubs"), ("localId", "name", "ip", "hubId")),
            "extenders": keep(raw.get("extenders"), ("localId", "name", "host")),
        }

    async def icons_list(self) -> set[str]:
        """Names of the icons stored on the remote (RF7.3)."""
        url = f"{self._base}/icons-list"
        try:
            async with self._session.get(url, timeout=TIMEOUT) as resp:
                if resp.status != 200:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
                return {str(n) for n in json.loads((await resp.read()).decode("utf-8"))}
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            raise DeviceError("invalid_json", str(err)) from err

    async def icon_get(self, name: str) -> tuple[bytes, str]:
        """Download one icon from the remote."""
        from urllib.parse import quote

        try:
            async with self._session.get(f"{self._base}/icons/{quote(name)}", timeout=TIMEOUT) as resp:
                if resp.status != 200:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
                return await resp.read(), resp.content_type
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err

    async def icon_upload(self, name: str, data: bytes, content_type: str) -> None:
        """Upload one icon like the remote's own Icons form (RF7.3)."""
        form = aiohttp.FormData()
        form.add_field("file", data, filename=name, content_type=content_type)
        _LOGGER.debug("POST %s/icons (%s)", self._base, name)
        try:
            async with self._session.post(
                f"{self._base}/icons", data=form, timeout=TIMEOUT, allow_redirects=False
            ) as resp:
                if resp.status >= 400:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err

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
