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
  ip, hubId}], ``extenders`` [{localId, name, host, mac}], ``appleTvs``
  (1.2.0: localId, name, entityId, credentials, ...) and ``ha`` (URL and
  token).  Only hubs and extenders are kept (RF8.1): the ``ha`` block, which
  holds the remote's HA token, is discarded and never stored or logged;
* ``GET  /info`` (1.2.7-beta) -> ``{id, name, manufacturer, model, android,
  version, versionCode, webhook}``: the remote's identity (RF10.9);
* ``DELETE /icons/<name>`` (1.2.3-beta) -> delete one icon (RF10.11);
* 1.3.0 version history of dashboard.json (RF12, ``DashboardHistory.kt``):
  ``GET /history`` -> ``{"versions": [{id, time, note, pinned, reason,
  restoredFrom, size, pages, cards}]}`` newest first; ``GET /history/<id>``
  -> that version's content; ``POST /history/pin`` (form ``id``,
  ``pinned=true|false``).  ``POST /dashboard.json`` also takes a ``note``
  form field, stored with the version the remote keeps for that save.
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
            # RF9.1 (upstream 1.2.0): paired Apple TVs. Their pairing
            # "credentials" and network details are deliberately not kept.
            "apple_tvs": keep(raw.get("appleTvs"), ("localId", "name", "entityId")),
        }

    async def info(self) -> dict[str, Any] | None:
        """RF10.9: identity of the remote; None on apps older than 1.2.7 (404)."""
        url = f"{self._base}/info"
        try:
            async with self._session.get(url, timeout=TIMEOUT) as resp:
                if resp.status == 404:
                    return None
                if resp.status != 200:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
                raw = json.loads((await resp.read()).decode("utf-8"))
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            raise DeviceError("invalid_json", str(err)) from err
        keys = ("id", "name", "manufacturer", "model", "android", "version", "versionCode", "webhook")
        return {k: raw.get(k) for k in keys} if isinstance(raw, dict) else None

    async def icon_delete(self, name: str) -> bool:
        """RF10.11: delete one icon on the remote; False if it was not there (404)."""
        from urllib.parse import quote

        try:
            async with self._session.delete(f"{self._base}/icons/{quote(name)}", timeout=TIMEOUT) as resp:
                if resp.status == 404:
                    return False
                if resp.status == 405:
                    raise DeviceError("not_supported", "DELETE /icons needs app 1.2.3-beta or later")
                if resp.status >= 400:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
                return True
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err

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

    async def upload(self, content: Any, note: str | None = None) -> None:
        """Upload ``content`` the same way the device's own form does (RF5.4).

        ``note`` (RF12.1): label of the version the remote keeps for this save
        (app 1.3.0+; older apps ignore the extra field).
        """
        url = f"{self._base}/dashboard.json"
        form = aiohttp.FormData()
        if note:
            form.add_field("note", note)
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

    # -- RF12: the remote's own version history (app 1.3.0+) ------------------

    async def history_list(self) -> list[dict[str, Any]] | None:
        """Versions kept by the remote, newest first; None when unsupported (404, app < 1.3.0)."""
        url = f"{self._base}/history"
        _LOGGER.debug("GET %s", url)
        try:
            async with self._session.get(url, timeout=TIMEOUT) as resp:
                if resp.status in (404, 405):
                    return None
                if resp.status != 200:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
                raw = json.loads((await resp.read()).decode("utf-8"))
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            raise DeviceError("invalid_json", str(err)) from err
        versions = raw.get("versions") if isinstance(raw, dict) else None
        if not isinstance(versions, list):
            return []
        keys = ("id", "time", "note", "pinned", "reason", "restoredFrom", "size", "pages", "cards")
        return [{k: v.get(k) for k in keys} for v in versions if isinstance(v, dict) and isinstance(v.get("id"), str)]

    async def history_get(self, version_id: str) -> Any:
        """Content of one remote version (parsed JSON)."""
        from urllib.parse import quote

        url = f"{self._base}/history/{quote(version_id)}"
        _LOGGER.debug("GET %s", url)
        try:
            async with self._session.get(url, timeout=TIMEOUT) as resp:
                if resp.status == 404:
                    raise DeviceError("remote_version_missing", version_id)
                if resp.status != 200:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
                return json.loads((await resp.read()).decode("utf-8"))
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            raise DeviceError("invalid_json", str(err)) from err

    async def history_pin(self, version_id: str, pinned: bool = True) -> bool:
        """RF12.2: pin a remote version so the remote never prunes it; False if unknown."""
        url = f"{self._base}/history/pin"
        _LOGGER.debug("POST %s (%s, pinned=%s)", url, version_id, pinned)
        try:
            async with self._session.post(
                url, data={"id": version_id, "pinned": "true" if pinned else "false"}, timeout=TIMEOUT
            ) as resp:
                if resp.status == 404:
                    return False
                if resp.status >= 400:
                    raise DeviceError("http_error", f"HTTP {resp.status}")
                return True
        except (aiohttp.ClientError, TimeoutError) as err:
            raise DeviceError("unreachable", str(err) or type(err).__name__) from err
