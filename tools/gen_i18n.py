"""Regenerate the I18N table of ``static/i18n.js`` from ``static/i18n_source.tsv``.

Project rule (RNF3): every UI string exists in EN, IT, FR, ES, DE. The TSV is
the single source (columns: key, en, it, fr, es, de); run after editing it:

    python3 tools/gen_i18n.py
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "astrion_config_manager" / "app" / "acm" / "static"
LANGS = ("en", "it", "fr", "es", "de")


def main() -> int:
    """Rewrite the ``const I18N = {...};`` block, keeping the rest of i18n.js."""
    with (STATIC / "i18n_source.tsv").open(encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE))
    missing = [r["key"] for r in rows if any(not (r.get(lang) or "").strip() for lang in LANGS)]
    if missing:
        print("missing translations:", ", ".join(missing), file=sys.stderr)
        return 1
    table = {lang: {r["key"]: r[lang] for r in rows} for lang in LANGS}
    js = (STATIC / "i18n.js").read_text(encoding="utf-8")
    start = js.index("const I18N = {")
    end = js.index("\n};", start) + 3
    block = "const I18N = " + json.dumps(table, ensure_ascii=False, indent=1) + ";"
    (STATIC / "i18n.js").write_text(js[:start] + block + js[end:], encoding="utf-8")
    print(f"{len(rows)} keys x {len(LANGS)} languages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
