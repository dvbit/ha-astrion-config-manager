"""Regenerate static/card_schema.json from the upstream Kotlin card renderers.

Usage: python3 tools/extract_card_schema.py <astrion-custom-dashboard checkout>

Each renderer under app/src/main/java/com/custom/astrion/cards/impl declares
``override val type = "<type>"`` and reads options through
``config.string/stringList/bool/int("key", default)`` or ``config.options["key"]``
(complex values). Kinds: string, string_list, bool, int, json.
"""

import contextlib
import glob
import json
import os
import re
import sys

ROOT = sys.argv[1]
OUT = os.path.join(
    os.path.dirname(__file__), "..", "astrion_config_manager", "app", "acm", "static", "card_schema.json"
)
KINDS = {"string": "string", "stringList": "string_list", "bool": "bool", "int": "int"}

schema = {}
for path in sorted(glob.glob(os.path.join(ROOT, "app/src/main/java/com/custom/astrion/cards/impl/*.kt"))):
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    for match in re.finditer(r'override val type = "([a-z_]+)"', src):
        fields = {}
        for acc in re.finditer(
            r'(?:config|cfg|c)\.(string|stringList|bool|int)\(\s*"([A-Za-z0-9_]+)"(?:\s*,\s*([^)\n]+))?\)', src
        ):
            kind, key, default = acc.groups()
            field = fields.setdefault(key, {"kind": KINDS[kind]})
            if default and "default" not in field:
                with contextlib.suppress(ValueError):
                    field["default"] = json.loads(default.strip())
        # options["key"] as? Boolean / Number -> bool / float; anything else -> json
        for opt in re.finditer(r'options\[\s*"([A-Za-z0-9_]+)"\s*\](\s*as\?\s*(Boolean|Number|String))?', src):
            cast = {"Boolean": "bool", "Number": "float", "String": "string"}.get(opt.group(3) or "", "json")
            current = fields.get(opt.group(1))
            if current is None or (current["kind"] == "json" and cast != "json"):
                fields[opt.group(1)] = {"kind": cast}
        schema[match.group(1)] = {"fields": fields}

with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(schema, fh, indent=1, sort_keys=True)
print(f"{len(schema)} card types -> {os.path.normpath(OUT)}")
