<img src="astrion_config_manager/logo.png" alt="Astrion Config Manager" width="250">

# Astrion Config Manager

Home Assistant **app (add-on)** to manage the `dashboard.json` of one or more
**Astrion HA100** remotes running
[astrion-custom-dashboard](https://github.com/dckiller51/astrion-custom-dashboard):
form editor, full version history with undo/redo and named versions,
validation against your HA entities, push/pull with drift detection.

🇮🇹 [Versione italiana](README.it.md) · 📄 Specification: [English](SPEC.en.md) · [Italiano](SPEC.md)

> v1.x = phase 1 of the specification (RF1–RF5). The visual simulator with
> real Harmony / Broadlink execution (RF6) is planned for v2.0.

## Installation

1. **Settings → Apps (Add-ons) → App store → ⋮ → Repositories**
2. Add `https://github.com/dvbit/ha-astrion-config-manager`
3. Install **Astrion Config Manager**, start it, open **Astrion** in the sidebar.

On each remote, enable the app's **config server** (port 8080, settings page).
Schema followed: upstream release **1.1.9-beta**.

## Features

| Area | What you get |
| --- | --- |
| Remotes | Register many remotes (name, IP, port, screen size, orientation, Harmony IP, IR entity). Archive instead of delete. |
| History | Every change is a version stored as a JSON Patch delta; snapshots every 50. Undo/redo are versions too. Restore any version in one step. |
| Named versions | Label milestones ("Before TV change"), filter them, restore them. Labels never alter history. |
| Editor | Forms for pages, cards (21 types, fields extracted from upstream renderers), hotkeys, IR devices, Activities, theme; raw JSON for everything. Unknown cards/fields survive untouched. |
| Validation | Structure + every referenced entity must exist in HA. Push is blocked on errors. |
| Sync | Pull, push with re-read verification, drift detection by canonical SHA-256. Drift is reported, never auto-applied. |
| Languages | English, Italian, French, Spanish, German (follows your HA language). |

## Usage examples

### 1. Register a remote

**+ Add remote** → `Living room`, `192.168.2.50`, port `8080`, `480`×`800`,
portrait. The initial pull creates **v1** (`import`). If the remote is
unreachable or has no `dashboard.json`, nothing is registered.

### 2. Edit and undo

Change a card's `name` and press Enter → **v2** (`edit`). Press **Undo** →
**v3** (`undo`) with the previous state. **Redo** → **v4** (`redo`). Any new
edit clears the redo stack.

### 3. Name a milestone and go back

History → v12 → **Name…** → `Before TV change`. Weeks later: **Restore** on
the named version → a new `restore` version with exactly that state.

### 4. Copy a page to another remote

Editor → page → **Copy to remote…** → `Bedroom`. One version is created on
the destination; name clashes get a numeric suffix (`Home 2`), links and IR
devices used by the page are copied and re-pointed.

### 5. Drift

Someone edited the remote from its own web builder. The list shows
**Changed on device**; inside the remote choose **Import as version**
(`sync-import`), **Overwrite with head** (push) or **Ignore**.

### 6. Push blocked by a missing entity

```json
{ "type": "light", "options": { "entity_id": "light.old_lamp" } }
```

`light.old_lamp` no longer exists in HA → *Entity not found in Home
Assistant* shown on the field; **Push** stays disabled until fixed.

## Data and backups

Everything lives in the app's `/data` volume (included in HA backups):

```
/data/remotes/<id>/meta.json          remote + sync state
/data/remotes/<id>/versions/*.json    one file per version (JSON Patch)
/data/remotes/<id>/snapshots/*.json.gz full state at v1 and every 50
/data/remotes/<id>/names.json         version names
```

Writes are atomic (temp file + fsync + rename): a version exists entirely or not at all.

## Logging

Option `log_level` (`trace`…`error`). INFO: versions, push/pull, archive.
WARNING: drift, blocked push, rejected commits, HA unreachable.
ERROR: failed push verification. DEBUG: HTTP calls, state rebuilds.

## Development

```bash
pip install -r astrion_config_manager/requirements.txt pytest pytest-aiohttp ruff
pytest -q && ruff check .
cd astrion_config_manager/app && ACM_ALLOW_ANY=1 ACM_DATA_DIR=/tmp/acm python3 -m acm
```

CI workflows are in `ci/` (move to `.github/workflows/`).

## License

GPL-3.0, like the upstream project the editor schema is derived from.
