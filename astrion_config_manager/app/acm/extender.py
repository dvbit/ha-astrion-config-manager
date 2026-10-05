"""IR extender client (spec RF8.4).

Same wire format as upstream ``extender/ExtenderClient.kt``: ``POST http://<host>/pronto`` with the Pronto
code as ``text/plain`` body (5 s timeouts).
"""

from __future__ import annotations

import logging

import aiohttp

_LOGGER = logging.getLogger(__name__)

TIMEOUT = aiohttp.ClientTimeout(total=5, connect=5)


class ExtenderError(Exception):
    """Extender unreachable or answered with an error."""


async def send_pronto(session: aiohttp.ClientSession, host: str, pronto: str) -> None:
    """Send one Pronto code to the extender at ``host``."""
    url = f"http://{host}/pronto"
    _LOGGER.debug("POST %s (%s words)", url, len(pronto.split()))
    try:
        async with session.post(
            url, data=pronto.encode("ascii"), headers={"Content-Type": "text/plain"}, timeout=TIMEOUT
        ) as resp:
            if resp.status >= 400:
                raise ExtenderError(f"HTTP {resp.status}")
    except (aiohttp.ClientError, TimeoutError) as err:
        raise ExtenderError(str(err) or type(err).__name__) from err
