"""Entry point: ``python3 -m acm`` (started by run.sh).

Environment:
  ACM_DATA_DIR   data volume (default /data, included in HA backups - RNF2)
  ACM_LOG_LEVEL  trace|debug|info|warning|error (add-on option ``log_level``)
  ACM_PORT       listen port (default 8099, the Ingress port)
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from aiohttp import web

from . import __version__
from .api import create_app

_LEVELS = {
    "trace": logging.DEBUG,
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warning": logging.WARNING,
    "error": logging.ERROR,
}


def main() -> None:
    """Configure logging and run the web server."""
    level = _LEVELS.get(os.environ.get("ACM_LOG_LEVEL", "info").lower(), logging.INFO)
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    # aiohttp access log only in debug.
    logging.getLogger("aiohttp.access").setLevel(logging.DEBUG if level <= logging.DEBUG else logging.WARNING)
    log = logging.getLogger("acm")
    data_dir = Path(os.environ.get("ACM_DATA_DIR", "/data"))
    port = int(os.environ.get("ACM_PORT", "8099"))
    log.info("Astrion Config Manager %s starting (data=%s, port=%s)", __version__, data_dir, port)
    web.run_app(create_app(data_dir), host="0.0.0.0", port=port, print=None)  # noqa: S104


if __name__ == "__main__":
    main()
