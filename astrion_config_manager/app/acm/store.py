"""Persistent store: remotes, delta version history, version names.

Layout under the add-on data volume (RNF2, included in HA backups)::

    <root>/remotes/<rid>/meta.json            remote fields + sync state (RF1, RF5)
    <root>/remotes/<rid>/names.json           version labels (RF2.11-RF2.13)
    <root>/remotes/<rid>/versions/<id>.json   one version = metadata + JSON Patch (RF2.1, RF2.8)
    <root>/remotes/<rid>/snapshots/<id>.json.gz  full state at v1 and every 50 (RF2.8)

Atomicity (RNF4): every file is written to a temp file, fsync'ed and moved
into place with ``os.replace``.  The version file is the commit marker: a
snapshot without its version file is an orphan that is simply overwritten
the next time, so a version exists entirely or not at all.

History is append-only and linear (RF2.2): no version file is ever rewritten
or deleted, and there is no delete API at all (spec section 2, RF1.4).

This module is synchronous; the API layer serialises access per remote with
an asyncio lock (RF2.10).
"""

from __future__ import annotations

import copy
import gzip
import json
import logging
import os
import re
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import jsonpatch

from .canonical import canonical_dumps

_LOGGER = logging.getLogger(__name__)

# RF2.1 version types.
T_IMPORT = "import"
T_EDIT = "edit"
T_UNDO = "undo"
T_REDO = "redo"
T_RESTORE = "restore"
T_SYNC_IMPORT = "sync-import"
VERSION_TYPES = {T_IMPORT, T_EDIT, T_UNDO, T_REDO, T_RESTORE, T_SYNC_IMPORT}

# RF2.4: version types that can be undone.
UNDOABLE = {T_EDIT, T_RESTORE, T_IMPORT, T_SYNC_IMPORT}

# RF2.8: full compressed snapshot at v1 and every SNAPSHOT_EVERY versions.
SNAPSHOT_EVERY = 50

# RF1.1 editable remote fields.
REMOTE_FIELDS = (
    "name",
    "host",
    "port",
    "width",
    "height",
    "orientation",
    "harmony_ip",
    "ir_entity",
)
ORIENTATIONS = {"portrait", "landscape"}

_ENTITY_RE = re.compile(r"^remote\.[a-z0-9_]+$")


class StoreError(Exception):
    """Business-rule violation; ``code`` is translated by the frontend."""

    def __init__(self, code: str, status: int = 400, **details: Any) -> None:
        """Store an error code, HTTP status and optional details."""
        super().__init__(code)
        self.code = code
        self.status = status
        self.details = details


class HeadMismatch(StoreError):
    """RF2.10: the client committed against a head that is no longer current."""

    def __init__(self, head: int) -> None:
        """Carry the current head so the UI can realign."""
        super().__init__("head_changed", 409, head=head)


# --------------------------------------------------------------------------
# File helpers (RNF4)
# --------------------------------------------------------------------------


def _fsync_dir(path: Path) -> None:
    """Flush a directory entry so a rename survives a power cut."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:  # pragma: no cover - not supported on every FS
        return
    try:
        os.fsync(fd)
    except OSError:  # pragma: no cover
        pass
    finally:
        os.close(fd)


def atomic_write(path: Path, data: bytes) -> None:
    """Write ``data`` to ``path`` atomically (temp file + fsync + rename)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        _fsync_dir(path.parent)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _write_json(path: Path, obj: Any) -> None:
    atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=1).encode("utf-8"))


def _read_json(path: Path) -> Any:
    with path.open("rb") as fh:
        return json.loads(fh.read().decode("utf-8"))


# --------------------------------------------------------------------------
# Field validation (RF1.1, RF1.3)
# --------------------------------------------------------------------------


def clean_fields(fields: dict[str, Any], partial: bool) -> dict[str, Any]:
    """Validate remote fields; ``partial`` allows a subset (RF1.3 edit)."""
    out: dict[str, Any] = {}
    for key in REMOTE_FIELDS:
        if key not in fields:
            continue
        val = fields[key]
        if key in ("name", "host"):
            val = str(val or "").strip()
            if not val:
                raise StoreError(f"{key}_required")
        elif key in ("port", "width", "height"):
            try:
                val = int(val)
            except (TypeError, ValueError):
                raise StoreError(f"{key}_invalid") from None
            if key == "port" and not 1 <= val <= 65535:
                raise StoreError("port_invalid")
            if key != "port" and val <= 0:
                raise StoreError(f"{key}_invalid")
        elif key == "orientation":
            if val not in ORIENTATIONS:
                raise StoreError("orientation_invalid")
        elif key == "harmony_ip":
            val = str(val or "").strip() or None
        elif key == "ir_entity":
            val = str(val or "").strip() or None
            if val and not _ENTITY_RE.match(val):
                raise StoreError("ir_entity_invalid")
        out[key] = val
    if not partial:
        fields_with_default = dict(out)
        fields_with_default.setdefault("port", 8080)  # RF1.1 default port
        fields_with_default.setdefault("harmony_ip", None)
        fields_with_default.setdefault("ir_entity", None)
        # RF1.1: no default for width/height/orientation.
        for key in ("name", "host", "width", "height", "orientation"):
            if key not in fields_with_default:
                raise StoreError(f"{key}_required")
        out = fields_with_default
    return out


# --------------------------------------------------------------------------
# Per-remote history
# --------------------------------------------------------------------------


@dataclass
class History:
    """In-memory view of one remote's version files."""

    path: Path
    versions: list[dict[str, Any]] = field(default_factory=list)
    _cache: dict[int, Any] = field(default_factory=dict)

    @property
    def head(self) -> int:
        """Id of the last version (the head)."""
        return self.versions[-1]["id"] if self.versions else 0

    def load(self) -> None:
        """Read all version files in id order."""
        vdir = self.path / "versions"
        self.versions = []
        if vdir.is_dir():
            files = sorted(p for p in vdir.glob("*.json") if p.stem.isdigit())
            self.versions = [_read_json(p) for p in files]
        # Integrity check of the linear chain (RF2.2).
        for idx, ver in enumerate(self.versions, start=1):
            if ver["id"] != idx:
                raise RuntimeError(f"{self.path}: broken version chain at {idx}")
        self._cache.clear()

    # -- state reconstruction (RF2.8) --------------------------------------

    def _snapshot_path(self, vid: int) -> Path:
        return self.path / "snapshots" / f"{vid:08d}.json.gz"

    def state(self, vid: int) -> Any:
        """Rebuild the full state at ``vid`` from nearest snapshot + patches."""
        if vid < 1 or vid > self.head:
            raise StoreError("version_not_found", 404, version=vid)
        if vid in self._cache:
            return copy.deepcopy(self._cache[vid])
        base = max(1, (vid // SNAPSHOT_EVERY) * SNAPSHOT_EVERY)
        with gzip.open(self._snapshot_path(base), "rb") as fh:
            state = json.loads(fh.read().decode("utf-8"))
        for ver in self.versions[base:vid]:  # versions base+1 .. vid
            state = jsonpatch.apply_patch(state, ver["patch"], in_place=False)
        # Keep only the head cached: the common path; history reads are rare.
        self._cache = {vid: state} if vid == self.head else self._cache
        _LOGGER.debug("Rebuilt %s v%s from snapshot v%s", self.path.name, vid, base)
        return copy.deepcopy(state)

    # -- undo / redo stacks (RF2.4, RF2.5) ---------------------------------

    def stacks(self) -> tuple[list[int], list[int]]:
        """Replay the history and return (undo stack, redo stack)."""
        undo: list[int] = []
        redo: list[int] = []
        for ver in self.versions:
            vtype = ver["type"]
            if vtype in UNDOABLE:
                undo.append(ver["id"])
                redo.clear()  # RF2.5: any new edit/restore/import resets redo
            elif vtype == T_UNDO:
                redo.append(undo.pop())
            elif vtype == T_REDO:
                undo.append(redo.pop())
        return undo, redo

    def undo_redo(self) -> dict[str, Any]:
        """Availability of undo and redo for the UI."""
        undo, redo = self.stacks()
        # Version 1 has no previous state, so it cannot be undone.
        can_undo = bool(undo) and undo[-1] > 1
        return {"can_undo": can_undo, "can_redo": bool(redo)}

    # -- append (RF2.2, RNF4) ----------------------------------------------

    def append(self, new_state: Any, vtype: str, user: str | None, ref: int | None = None) -> dict[str, Any]:
        """Append a version holding ``new_state``; returns its metadata."""
        vid = self.head + 1
        if vid == 1:
            patch: list[dict[str, Any]] = []
        else:
            patch = jsonpatch.make_patch(self.state(self.head), new_state).patch
        ver = {
            "id": vid,
            "parent": vid - 1 if vid > 1 else None,
            "ts": time.time(),
            "user": user,
            "type": vtype,
            "ref": ref,
            "patch": patch,
        }
        if vid == 1 or vid % SNAPSHOT_EVERY == 0:
            data = gzip.compress(canonical_dumps(new_state).encode("utf-8"))
            atomic_write(self._snapshot_path(vid), data)
        # Writing the version file is the commit point.
        _write_json(self.path / "versions" / f"{vid:08d}.json", ver)
        self.versions.append(ver)
        self._cache = {vid: copy.deepcopy(new_state)}
        _LOGGER.info(
            "Version %s created on %s (type=%s, ops=%s, user=%s)",
            vid,
            self.path.name,
            vtype,
            len(patch),
            user,
        )
        return ver


# --------------------------------------------------------------------------
# Store
# --------------------------------------------------------------------------


class Store:
    """All remotes, their histories and version names."""

    def __init__(self, root: Path) -> None:
        """Open (or create) the store rooted at ``root``."""
        self.root = Path(root)
        self.rdir = self.root / "remotes"
        self.rdir.mkdir(parents=True, exist_ok=True)
        self._meta: dict[str, dict[str, Any]] = {}
        self._hist: dict[str, History] = {}
        self._names: dict[str, dict[str, str]] = {}
        for path in sorted(self.rdir.iterdir()):
            if (path / "meta.json").is_file():
                self._load_remote(path.name)
        _LOGGER.info("Store opened at %s: %s remote(s)", self.root, len(self._meta))

    def _load_remote(self, rid: str) -> None:
        path = self.rdir / rid
        hist = History(path)
        hist.load()
        if hist.head == 0:
            # Registration crashed before v1 was committed: not a remote.
            _LOGGER.warning("Skipping %s: no committed version", rid)
            return
        self._meta[rid] = _read_json(path / "meta.json")
        self._hist[rid] = hist
        names_path = path / "names.json"
        self._names[rid] = _read_json(names_path) if names_path.is_file() else {}

    # -- remotes (RF1) ------------------------------------------------------

    def _get(self, rid: str) -> dict[str, Any]:
        if rid not in self._meta:
            raise StoreError("remote_not_found", 404)
        return self._meta[rid]

    def check_unique_name(self, name: str, exclude: str | None = None) -> None:
        """RF1.1: name unique among non-archived remotes (case-insensitive)."""
        for rid, meta in self._meta.items():
            if rid == exclude or meta.get("archived"):
                continue
            if meta["name"].casefold() == name.casefold():
                raise StoreError("name_taken", 409)

    def list_remotes(self, archived: bool = False) -> list[dict[str, Any]]:
        """Remotes in the main list or, with ``archived``, the archive view."""
        out = []
        for rid, meta in self._meta.items():
            if bool(meta.get("archived")) == archived:
                out.append(self.remote_info(rid))
        return sorted(out, key=lambda m: m["name"].casefold())

    def remote_info(self, rid: str) -> dict[str, Any]:
        """Meta + head + undo/redo availability."""
        meta = dict(self._get(rid))
        hist = self._hist[rid]
        meta.update({"head": hist.head, **hist.undo_redo()})
        return meta

    def create_remote(self, fields: dict[str, Any], content: Any, user: str | None, device_hash: str) -> dict[str, Any]:
        """RF1.2: register after a successful pull; v1 is an ``import``."""
        clean = clean_fields(fields, partial=False)
        self.check_unique_name(clean["name"])
        rid = uuid.uuid4().hex[:12]
        path = self.rdir / rid
        meta = {
            "id": rid,
            **clean,
            "archived": False,
            "created": time.time(),
            "baseline": device_hash,  # glossary: hash of last successful pull/push
            "last_push_version": None,
            "last_push_at": None,
        }
        hist = History(path)
        # v1 first: if this fails nothing is registered (meta.json absent).
        hist.append(content, T_IMPORT, user)
        _write_json(path / "meta.json", meta)
        self._meta[rid], self._hist[rid], self._names[rid] = meta, hist, {}
        _LOGGER.info("Remote '%s' registered (%s:%s)", clean["name"], clean["host"], clean["port"])
        return self.remote_info(rid)

    def update_remote(self, rid: str, fields: dict[str, Any]) -> dict[str, Any]:
        """RF1.3: every field can be edited after registration."""
        meta = self._get(rid)
        clean = clean_fields(fields, partial=True)
        if "name" in clean and not meta.get("archived"):
            self.check_unique_name(clean["name"], exclude=rid)
        meta.update(clean)
        _write_json(self.rdir / rid / "meta.json", meta)
        _LOGGER.info("Remote '%s' updated: %s", meta["name"], ", ".join(clean))
        return self.remote_info(rid)

    def set_archived(self, rid: str, archived: bool) -> dict[str, Any]:
        """RF1.4: archive instead of delete; restore from the archive view."""
        meta = self._get(rid)
        if not archived:
            self.check_unique_name(meta["name"], exclude=rid)
        meta["archived"] = archived
        _write_json(self.rdir / rid / "meta.json", meta)
        _LOGGER.info("Remote '%s' %s", meta["name"], "archived" if archived else "restored")
        return self.remote_info(rid)

    def set_devices(self, rid: str, hubs: list[dict[str, str]], extenders: list[dict[str, str]]) -> None:
        """RF8.1: keep the hubs/extenders read from the remote (read-only copy)."""
        meta = self._get(rid)
        meta.update({"harmony_hubs": hubs, "extenders": extenders, "devices_read_at": time.time()})
        _write_json(self.rdir / rid / "meta.json", meta)
        _LOGGER.info("Remote '%s': %s hub(s), %s extender(s) read", meta["name"], len(hubs), len(extenders))

    def set_sync(self, rid: str, **values: Any) -> None:
        """Persist baseline / last push information (RF5)."""
        meta = self._get(rid)
        meta.update(values)
        _write_json(self.rdir / rid / "meta.json", meta)

    # -- versions (RF2) -----------------------------------------------------

    def history(self, rid: str) -> History:
        """Return the history of a remote (raises if unknown)."""
        self._get(rid)
        return self._hist[rid]

    def _check_head(self, rid: str, expected: int) -> History:
        hist = self.history(rid)
        if expected != hist.head:
            _LOGGER.warning("Commit on %s rejected: client head %s, current %s", rid, expected, hist.head)
            raise HeadMismatch(hist.head)
        return hist

    def head_state(self, rid: str) -> Any:
        """Full state of the head."""
        hist = self.history(rid)
        return hist.state(hist.head)

    def commit(
        self, rid: str, expected: int, new_state: Any, user: str | None, vtype: str = T_EDIT
    ) -> dict[str, Any] | None:
        """RF2.3: one version per commit with a non-empty delta, else None."""
        hist = self._check_head(rid, expected)
        if canonical_dumps(new_state) == canonical_dumps(hist.state(hist.head)):
            _LOGGER.debug("Commit on %s without changes: no version", rid)
            return None
        return hist.append(new_state, vtype, user)

    def undo(self, rid: str, expected: int, user: str | None) -> dict[str, Any]:
        """RF2.4: new ``undo`` version with the state before the last undoable."""
        hist = self._check_head(rid, expected)
        undo, _ = hist.stacks()
        if not undo or undo[-1] <= 1:
            raise StoreError("nothing_to_undo")
        target = undo[-1]
        state = hist.state(hist.versions[target - 1]["parent"])
        return hist.append(state, T_UNDO, user, ref=target)

    def redo(self, rid: str, expected: int, user: str | None) -> dict[str, Any]:
        """RF2.5: new ``redo`` version restoring the last undone version."""
        hist = self._check_head(rid, expected)
        _, redo = hist.stacks()
        if not redo:
            raise StoreError("nothing_to_redo")
        target = redo[-1]
        return hist.append(hist.state(target), T_REDO, user, ref=target)

    def restore(self, rid: str, expected: int, target: int, user: str | None) -> dict[str, Any]:
        """RF2.6 / RF2.13: restore any version in one step as a ``restore``."""
        hist = self._check_head(rid, expected)
        return hist.append(hist.state(target), T_RESTORE, user, ref=target)

    # -- version names (RF2.11-RF2.13) ------------------------------------

    def names(self, rid: str) -> dict[str, str]:
        """Return the mapping version id (as string) -> name."""
        self._get(rid)
        return dict(self._names[rid])

    def set_name(self, rid: str, vid: int, name: str | None) -> dict[str, str]:
        """Assign, rename or (``name`` empty/None) remove a version label.

        Labels never create versions nor touch history (RF2.12).
        """
        hist = self.history(rid)
        if vid < 1 or vid > hist.head:
            raise StoreError("version_not_found", 404, version=vid)
        names = dict(self._names[rid])
        key = str(vid)
        name = (name or "").strip()
        if not name:
            names.pop(key, None)
            _LOGGER.info("Name removed from v%s on %s", vid, rid)
        else:
            for other, existing in names.items():
                if other != key and existing.casefold() == name.casefold():
                    raise StoreError("version_name_taken", 409)
            names[key] = name
            _LOGGER.info("Version v%s on %s named '%s'", vid, rid, name)
        _write_json(self.rdir / rid / "names.json", names)
        self._names[rid] = names
        return dict(names)
