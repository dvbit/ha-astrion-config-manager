"""Shared icon library (spec RF7.1-RF7.4).

Icons are image files the remote stores in ``<sdcard>/astrion/icons`` and
cards reference by path, e.g. ``"icon": "/sdcard/astrion/icons/disco.png"``
(upstream ``web/ConfigServer.kt``: ``POST /icons``, ``GET /icons-list``,
``GET /icons/<name>``; no delete endpoint exists on the remote).

The add-on keeps one library in ``/data/icons`` (included in HA backups):
missing icons are uploaded to a remote on push (RF7.3).  File names are
sanitised exactly like upstream ``sanitize()`` so names match on both sides.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from .store import StoreError, atomic_write

_LOGGER = logging.getLogger(__name__)

# Same rule as ConfigServer.sanitize(): basename, then [^A-Za-z0-9._-] -> "_".
_SANITIZE = re.compile(r"[^A-Za-z0-9._-]")
# Path prefixes that point to the remote's icon folder (docs use /sdcard).
ICON_PATH_PREFIX = "/sdcard/astrion/icons/"
_ICON_REF = re.compile(r"(?:^|/)astrion/icons/([A-Za-z0-9._-]+)$")
# Formats accepted by the remote's own upload form (image/png, jpeg, webp).
MAGIC = {
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
}
MAX_BYTES = 2 * 1024 * 1024
CONTENT_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}


def sanitize(name: str) -> str:
    """Port of upstream ``sanitize``."""
    return _SANITIZE.sub("_", name.rsplit("/", 1)[-1])


def icon_path(name: str) -> str:
    """Value written into a card's icon field for library icon ``name``."""
    return ICON_PATH_PREFIX + name


def icon_ref(value: Any) -> str | None:
    """Return the icon file name if ``value`` is a remote icon path."""
    if isinstance(value, str):
        match = _ICON_REF.search(value)
        if match:
            return match.group(1)
    return None


def collect_refs(node: Any, path: str = "", out: dict[str, list[str]] | None = None) -> dict[str, list[str]]:
    """All icon paths used anywhere in the document -> JSON pointers (RF7.4)."""
    out = {} if out is None else out
    if isinstance(node, dict):
        for key, val in node.items():
            collect_refs(val, f"{path}/{str(key).replace('~', '~0').replace('/', '~1')}", out)
    elif isinstance(node, list):
        for idx, val in enumerate(node):
            collect_refs(val, f"{path}/{idx}", out)
    else:
        name = icon_ref(node)
        if name:
            out.setdefault(name, []).append(path)
    return out


def _detect(data: bytes) -> str | None:
    for magic, ctype in MAGIC.items():
        if data.startswith(magic):
            return ctype
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


class IconLibrary:
    """Icon files in ``<root>/icons``."""

    def __init__(self, root: Path) -> None:
        """Create the folder if needed."""
        self.dir = Path(root) / "icons"
        self.dir.mkdir(parents=True, exist_ok=True)

    def names(self) -> set[str]:
        """File names in the library."""
        return {p.name for p in self.dir.iterdir() if p.is_file() and not p.name.startswith(".")}

    def list(self) -> list[dict[str, Any]]:
        """Library content for the UI."""
        return [{"name": n, "size": (self.dir / n).stat().st_size, "path": icon_path(n)} for n in sorted(self.names())]

    def add(self, filename: str, data: bytes) -> str:
        """Store an uploaded image; returns the sanitised name (overwrites)."""
        name = sanitize(filename or "")
        if not name or name.startswith("."):
            raise StoreError("icon_name_invalid")
        if len(data) > MAX_BYTES:
            raise StoreError("icon_too_large")
        if _detect(data) is None:
            raise StoreError("icon_format_invalid")
        atomic_write(self.dir / name, data)
        _LOGGER.info("Icon '%s' stored in library (%s bytes)", name, len(data))
        return name

    def read(self, name: str) -> tuple[bytes, str]:
        """Return (bytes, content type) of a library icon."""
        name = sanitize(name)
        path = self.dir / name
        if not path.is_file():
            raise StoreError("icon_not_found", 404)
        data = path.read_bytes()
        return data, _detect(data) or "application/octet-stream"

    def delete(self, name: str) -> None:
        """RF7.2: remove from the library only (the remote keeps its copy)."""
        path = self.dir / sanitize(name)
        if not path.is_file():
            raise StoreError("icon_not_found", 404)
        path.unlink()
        _LOGGER.info("Icon '%s' removed from library", path.name)
