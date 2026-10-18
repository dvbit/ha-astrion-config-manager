"""Shared theme library (spec RF14).

A theme is a name plus the remote's ``theme`` block (upstream
``config/AppConfig.kt`` ThemeConfig: 12 colour keys, ``#RRGGBB`` or
``#AARRGGBB``), stored exactly as set: a key left out keeps the remote's own
default.  The library is shared by every remote and lives in
``<data>/themes/<id>.json`` (included in HA backups, like the icon library).

* RF14.1 names unique (case-insensitive), presets included;
* RF14.2 read-only presets: Default (empty block = the remote's built-in
  theme), Light, OLED black, High contrast;
* RF14.4 import accepts our own export ``{"name", "theme"}``, a bare theme
  block or a whole dashboard.json (its ``theme``); invalid colours and unknown
  keys are reported and dropped.
"""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path
from typing import Any

from .store import StoreError, _read_json, _write_json
from .validate import _COLOR_RE, HINTS

_LOGGER = logging.getLogger(__name__)

# ThemeConfig keys, in the order the editor shows them (field_hints.json "theme").
THEME_KEYS: tuple[str, ...] = tuple(HINTS["theme"])
NAME_MAX = 60
_SLUG = re.compile(r"[^a-z0-9]+")

# RF14.2 presets: "default" is the empty block (remote built-ins, ThemeConfig defaults).
PRESETS: dict[str, dict[str, Any]] = {
    "default": {"name": "Default", "theme": {}},
    "light": {
        "name": "Light",
        "theme": {
            "background": "#F4F6F8", "cardSurface": "#FFFFFF", "insetSurface": "#EEF1F4",
            "controlBackground": "#DDE3E8", "primaryText": "#1B1F24", "mutedText": "#5F6B76",
            "iconTint": "#37424D", "accent": "#1565C0", "accentSecondary": "#3949AB",
            "amber": "#E69500", "danger": "#C62828", "success": "#2E7D32",
        },
    },
    "oled": {
        "name": "OLED black",
        "theme": {
            "background": "#000000", "cardSurface": "#0D0D0D", "insetSurface": "#080808",
            "controlBackground": "#1A1A1A", "primaryText": "#F2F2F2", "mutedText": "#8C8C8C",
            "iconTint": "#D0D0D0", "accent": "#4DA3FF", "accentSecondary": "#3D5AFE",
            "amber": "#FFB300", "danger": "#FF5252", "success": "#00C853",
        },
    },
    "contrast": {
        "name": "High contrast",
        "theme": {
            "background": "#000000", "cardSurface": "#111111", "insetSurface": "#000000",
            "controlBackground": "#333333", "primaryText": "#FFFFFF", "mutedText": "#E0E0E0",
            "iconTint": "#FFFFFF", "accent": "#FFD600", "accentSecondary": "#00E5FF",
            "amber": "#FFAB00", "danger": "#FF1744", "success": "#00E676",
        },
    },
}  # fmt: skip


def clean_theme(raw: Any) -> tuple[dict[str, str], list[dict[str, str]]]:
    """Keep the valid ThemeConfig colours; report what is dropped (RF14.4)."""
    if not isinstance(raw, dict):
        raise StoreError("theme_invalid")
    theme: dict[str, str] = {}
    rejected: list[dict[str, str]] = []
    for key, val in raw.items():
        if key not in THEME_KEYS:
            rejected.append({"key": str(key), "reason": "unknown_key"})
        elif not (isinstance(val, str) and _COLOR_RE.match(val)):
            rejected.append({"key": key, "reason": "color_invalid", "value": str(val)})
        else:
            theme[key] = val if val.startswith("#") else "#" + val
    return {k: theme[k] for k in THEME_KEYS if k in theme}, rejected


def theme_from_file(data: Any) -> tuple[str | None, Any]:
    """Name + raw theme from an imported file: export, bare block or dashboard.json."""
    if isinstance(data, dict) and isinstance(data.get("theme"), dict):
        name = data.get("name") if isinstance(data.get("name"), str) else None
        return name, data["theme"]
    if isinstance(data, dict) and any(k in THEME_KEYS for k in data):
        return None, data
    raise StoreError("theme_invalid")


class ThemeLibrary:
    """Themes in ``<data>/themes``; presets are built in and read-only."""

    def __init__(self, data_dir: Path) -> None:
        """Open (and create) the library folder."""
        self.dir = Path(data_dir) / "themes"
        self.dir.mkdir(parents=True, exist_ok=True)
        _LOGGER.debug("Theme library at %s: %s saved theme(s)", self.dir, len(list(self.dir.glob("*.json"))))

    # -- reading ---------------------------------------------------------------

    def _saved(self) -> dict[str, dict[str, Any]]:
        out = {}
        for path in sorted(self.dir.glob("*.json")):
            try:
                item = _read_json(path)
            except (OSError, ValueError) as err:
                _LOGGER.warning("Theme file %s unreadable, skipped: %s", path.name, err)
                continue
            if isinstance(item, dict) and isinstance(item.get("name"), str) and isinstance(item.get("theme"), dict):
                out[path.stem] = item
        return out

    def list(self) -> list[dict[str, Any]]:
        """Presets first, then saved themes by name."""
        presets = [
            {"id": f"preset:{k}", "name": v["name"], "theme": v["theme"], "preset": True} for k, v in PRESETS.items()
        ]
        saved = [
            {"id": k, "name": v["name"], "theme": v["theme"], "preset": False, "updated": v.get("updated")}
            for k, v in self._saved().items()
        ]
        return presets + sorted(saved, key=lambda x: x["name"].lower())

    def get(self, theme_id: str) -> dict[str, Any]:
        """One theme by id (``preset:<key>`` or a saved id)."""
        for item in self.list():
            if item["id"] == theme_id:
                return item
        raise StoreError("theme_not_found", 404)

    # -- writing ---------------------------------------------------------------

    def _check_name(self, name: Any, exclude: str | None = None) -> str:
        name = str(name or "").strip()
        if not name:
            raise StoreError("theme_name_required")
        if len(name) > NAME_MAX:
            raise StoreError("theme_name_too_long")
        for item in self.list():
            if item["name"].lower() == name.lower() and item["id"] != exclude:
                raise StoreError("theme_name_exists", 409, id=item["id"], preset=item["preset"])
        return name

    def _new_id(self, name: str) -> str:
        base = _SLUG.sub("_", name.lower()).strip("_")[:40] or "theme"
        tid, n = base, 1
        while (self.dir / f"{tid}.json").exists():
            n += 1
            tid = f"{base}_{n}"
        return tid

    def save(self, name: Any, theme: Any, overwrite: bool = False) -> dict[str, Any]:
        """RF14.3 Save as: new theme, or replace a saved one with the same name if ``overwrite``."""
        clean, rejected = clean_theme(theme)
        if rejected:
            _LOGGER.info("Theme '%s': %s value(s) dropped: %s", name, len(rejected), rejected)
        try:
            name = self._check_name(name)
            tid = self._new_id(name)
            created = time.time()
        except StoreError as err:
            if err.code != "theme_name_exists" or not overwrite or err.details.get("preset"):
                raise
            tid = err.details["id"]
            created = self._saved()[tid].get("created", time.time())
            name = self._saved()[tid]["name"]
            _LOGGER.info("Theme '%s' overwritten", name)
        _write_json(
            self.dir / f"{tid}.json", {"name": name, "theme": clean, "created": created, "updated": time.time()}
        )
        _LOGGER.info("Theme '%s' saved (%s colour(s))", name, len(clean))
        return {**self.get(tid), "rejected": rejected}

    def rename(self, theme_id: str, name: Any) -> dict[str, Any]:
        """RF14.4 rename a saved theme (presets are read-only)."""
        item = self._writable(theme_id)
        name = self._check_name(name, exclude=theme_id)
        saved = self._saved()[theme_id]
        saved.update({"name": name, "updated": time.time()})
        _write_json(self.dir / f"{theme_id}.json", saved)
        _LOGGER.info("Theme '%s' renamed to '%s'", item["name"], name)
        return self.get(theme_id)

    def delete(self, theme_id: str) -> None:
        """RF14.3 delete a saved theme (presets cannot be deleted)."""
        item = self._writable(theme_id)
        (self.dir / f"{theme_id}.json").unlink()
        _LOGGER.info("Theme '%s' deleted", item["name"])

    def _writable(self, theme_id: str) -> dict[str, Any]:
        item = self.get(theme_id)
        if item["preset"]:
            raise StoreError("theme_preset_readonly", 403)
        return item
