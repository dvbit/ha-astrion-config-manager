"""Canonical JSON form and hashing.

Spec RF5.2: drift is detected by comparing the SHA-256 of the *canonical*
JSON (sorted keys, normalised whitespace) of the device file with the
baseline.  Spec RF3.2: key order is not guaranteed, only semantic identity,
so every comparison in the add-on goes through this module.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_dumps(obj: Any) -> str:
    """Serialise ``obj`` with sorted keys and no insignificant whitespace."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_hash(obj: Any) -> str:
    """Return the hex SHA-256 of the canonical serialisation of ``obj``."""
    return hashlib.sha256(canonical_dumps(obj).encode("utf-8")).hexdigest()


def pretty_dumps(obj: Any) -> str:
    """Human-readable serialisation used for the file uploaded to the device."""
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
