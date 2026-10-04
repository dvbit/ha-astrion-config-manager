"""Copy pages and cards between remotes (spec RF3.3).

The result is applied to the destination as a single version.  Collisions
are solved with a numeric suffix and internal references among the copied
elements are rewritten:

* page names  -> keys ``page``, ``linkedPage``, ``parent``, ``*_page``
  (scene_grid tiles, title card, page links, hotkeys);
* IR devices  -> key ``irDevice``; referenced devices are copied along, or
  reused when the destination already has an identical one.
"""

from __future__ import annotations

import copy
from typing import Any

from .canonical import canonical_dumps

PAGE_REF_KEYS = {"page", "linkedPage", "parent"}


class CopyError(Exception):
    """Invalid copy request; ``code`` is translated by the frontend."""

    def __init__(self, code: str) -> None:
        """Keep a stable error code."""
        super().__init__(code)
        self.code = code


def _unique(base: str, taken: set[str], sep: str) -> str:
    """Return ``base`` or ``base<sep>N`` with the first free N >= 2."""
    if base not in taken:
        return base
    num = 2
    while f"{base}{sep}{num}" in taken:
        num += 1
    return f"{base}{sep}{num}"


def _walk(node: Any, fn) -> None:
    """Call ``fn(dict)`` on every dict of a JSON tree."""
    if isinstance(node, dict):
        fn(node)
        for val in node.values():
            _walk(val, fn)
    elif isinstance(node, list):
        for val in node:
            _walk(val, fn)


def _rewrite(node: Any, pages: dict[str, str], irs: dict[str, str]) -> None:
    """Rewrite page and IR device references in place."""

    def fix(obj: dict) -> None:
        for key, val in list(obj.items()):
            if not isinstance(val, str):
                continue
            if (key in PAGE_REF_KEYS or key.endswith("_page")) and val in pages:
                obj[key] = pages[val]
            elif key == "irDevice" and val in irs:
                obj[key] = irs[val]

    _walk(node, fix)


def _ir_refs(node: Any) -> set[str]:
    refs: set[str] = set()
    _walk(node, lambda o: refs.add(o["irDevice"]) if isinstance(o.get("irDevice"), str) else None)
    return refs


def _bring_ir_devices(src: dict, dst: dict, elements: Any) -> dict[str, str]:
    """Copy IR devices referenced by ``elements`` into ``dst``; return renames."""
    src_devs = {d.get("id"): d for d in src.get("irDevices", []) if isinstance(d, dict)}
    dst_list = dst.setdefault("irDevices", [])
    dst_devs = {d.get("id"): d for d in dst_list if isinstance(d, dict)}
    renames: dict[str, str] = {}
    for ref in sorted(_ir_refs(elements)):
        dev = src_devs.get(ref)
        if dev is None:
            continue  # dangling in the source too: leave as is
        if ref in dst_devs and canonical_dumps(dst_devs[ref]) == canonical_dumps(dev):
            continue  # identical device already present: reuse
        new_id = _unique(ref, set(dst_devs), "_")
        new_dev = copy.deepcopy(dev)
        new_dev["id"] = new_id
        dst_list.append(new_dev)
        dst_devs[new_id] = new_dev
        if new_id != ref:
            renames[ref] = new_id
    return renames


def _pages(doc: Any) -> list:
    if not isinstance(doc, dict) or not isinstance(doc.get("pages"), list):
        raise CopyError("copy_invalid_document")
    return doc["pages"]


def copy_pages(src: Any, indices: list[int], dst: Any) -> Any:
    """Append source pages ``indices`` to a copy of ``dst`` and return it."""
    src_pages = _pages(src)
    out = copy.deepcopy(dst)
    dst_pages = _pages(out)
    try:
        chosen = [copy.deepcopy(src_pages[i]) for i in indices]
    except (IndexError, TypeError):
        raise CopyError("copy_invalid_selection") from None
    if not chosen:
        raise CopyError("copy_invalid_selection")
    taken = {p.get("name") for p in dst_pages if isinstance(p, dict)}
    page_map: dict[str, str] = {}
    for page in chosen:
        old = page.get("name", "Page")
        new = _unique(old, taken, " ")
        taken.add(new)
        page["name"] = new
        page_map[old] = new
    ir_map = _bring_ir_devices(src, out, chosen)
    _rewrite(chosen, page_map, ir_map)
    dst_pages.extend(chosen)
    return out


def copy_cards(src: Any, src_page: int, indices: list[int], dst: Any, dst_page: int) -> Any:
    """Append cards of a source page to a destination page; return new doc."""
    out = copy.deepcopy(dst)
    try:
        cards = _pages(src)[src_page].get("cards", [])
        chosen = [copy.deepcopy(cards[i]) for i in indices]
        target = _pages(out)[dst_page]
    except (IndexError, TypeError, AttributeError):
        raise CopyError("copy_invalid_selection") from None
    if not chosen:
        raise CopyError("copy_invalid_selection")
    ir_map = _bring_ir_devices(src, out, chosen)
    _rewrite(chosen, {}, ir_map)
    target.setdefault("cards", []).extend(chosen)
    return out
