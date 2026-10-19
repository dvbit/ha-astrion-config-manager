<img src="astrion_config_manager/logo.png" alt="Astrion Config Manager" width="250">

# Astrion Config Manager

Home Assistant **app (add-on)** to manage the `dashboard.json` of one or more
**Astrion HA100** remotes running
[astrion-custom-dashboard](https://github.com/dckiller51/astrion-custom-dashboard):
form editor, full version history with undo/redo and named versions
(integrated with the remote's own history since app 1.3.0), validation
against your HA entities, push/pull with drift detection, live simulator.

🇮🇹 [Versione italiana](README.it.md) · 📄 Specification: [English](SPEC.en.md) · [Italiano](SPEC.md)

> v2.0 implements the whole specification (RF1–RF6), simulator included.

## Installation

1. **Settings → Apps (Add-ons) → App store → ⋮ → Repositories**
2. Add `https://github.com/dvbit/ha-astrion-config-manager`
3. Install **Astrion Config Manager**, start it, open **Astrion** in the sidebar.

On each remote, enable the app's **config server** (port 8080, settings page).
Schema followed: upstream release **1.3.0** and beta **1.3.2-beta** (card fields regenerated with `tools/extract_card_schema.py`; card fields regenerated with `tools/extract_card_schema.py`). Keys added by the betas are ignored by older apps.

## Features

| Area | What you get |
| --- | --- |
| Remotes | Register many remotes (name, IP, port, screen size, orientation, Harmony IP, IR entity). Archive instead of delete. |
| History | Every change is a version stored as a JSON Patch delta; snapshots every 50. Undo/redo are versions too. Restore any version in one step. |
| Remote history (1.3.0) | The remote's own versions listed in History: pushes labelled `ACM v<n>`, named ones optionally pinned, drift explained, any remote version comparable and importable. |
| Navigation map | Above the Editor and the Simulator: every page as a live mini preview, one icon per way to reach it (swipe, tap, long press, key, Activity, HA state, popup, back); zoom, pan, click to edit. |
| Themes | Shared theme library with presets: load / save / delete in the Editor, a Themes tab to preview, export, import and apply to several remotes. |
| Named versions | Label milestones ("Before TV change"), filter them, restore them. Labels never alter history. |
| Editor | Dropdowns for fixed values, colour palettes (cards and theme). Forms for pages, cards (21 types, fields extracted from upstream renderers), hotkeys, IR devices, Activities, theme; raw JSON for everything. Unknown cards/fields survive untouched. |
| Validation | Structure + every referenced entity must exist in HA. Push is blocked on errors. |
| Sync | Pull and Push from the Sync tab, the remote list or the remote's header; push with re-read verification, drift detection by canonical SHA-256. Drift is reported, never auto-applied. |
| Icons | Shared library (backed up), picker with thumbnails, automatic upload of missing icons on push, import from a remote. |
| Entity catalog | Form for `haDevices` (named entities used by the remote's web builder), validated against HA. |
| Simulator | The head rendered at the remote's resolution with live HA states; taps and HA100 keys run **for real** on HA, the Harmony Hub and the Broadlink IR emitter. |
| Dock & standby (1.2.7) | "Dock screen" and "Standby & battery" sections; pages hidden completely (`hideMode: full`); Off buttons (`stopActivity`); hotkey events to HA; Apple TV compact/full layouts with app shortcuts; remote identity and duplicate detection; icon deletion on the remotes. |
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

### 7. Simulator

Open the **Simulator** tab. The screen shows the head with live states. Tap a
light tile → `light.toggle` runs on HA and the tile updates. A scene tile with
`"activity": "watch_tv"` runs the composed Activity (power on, inputs, delays)
and jumps to its page. Swipe sideways for pages, up for the linked page; hold an
HA100 key for its long-press hotkey. Turn on **Navigation only** to try the
flow without touching your devices: actions are listed instead of executed.

Optional fields of the remote enable the other actions:

| Field | Example | Enables |
| --- | --- | --- |
| Hubs read from the remote | *Hub Salotto*, *Hub Camera* | `harmonyCommand`, `activityId`, Apple TV card, routed by `hub` |
| Harmony Hub IP (fallback) | `192.168.2.30` | same, when the remote has no hubs |
| Extenders read from the remote | *Ext TV* | IR devices with `target: {"extender": ...}` |
| IR emitter entity | `remote.broadlink_salotto` | IR devices with `local` target (inline or ir-database codes) |

Without them those buttons are shown disabled with the reason. IR codes are
converted to Broadlink `b64:` packets; the carrier frequency is fixed by the
Broadlink device (~38 kHz).

### 8. Icons and entity catalog

**Icons** tab → upload `disco.png`. In a `button_grid`, put the cursor inside
`"icon": ""` of a button and press **🖼 Insert icon** → `disco.png`:

```json
{ "name": "Disco", "icon": "/sdcard/astrion/icons/disco.png", "service": "scene.turn_on", "entity_id": "scene.disco" }
```

On **Push** the add-on uploads `disco.png` to the remote if it is missing there.
Already have icons on a remote? **Sync → Import into library**.

**Editor → HA devices (catalog)** → add `Salon TV`, type *Media Player*,
entity `media_player.tv`. The entry is stored in `haDevices` and shown with ★
in every entity field.

### 9. What's new with app 1.2.7-beta

**Dock screen** — *Editor → Global → Dock screen*: mode `clock`, weather
`weather.home`. Stored as:

```json
"dock": { "mode": "clock", "weather_entity": "weather.home", "time_format": 24 },
"power": { "screen_timeout_seconds": 60, "screen_off_entities": ["binary_sensor.tv_on"] }
```

In the **Simulator**, tick **Docked** to preview it (tap the screen to leave).

**Harmony-style Off button** — a scene tile with `"stopActivity": "Living room"`
(or `"*"` for every room) stops that room's Activity: composed stop or Harmony
PowerOff. Pick the room from the dropdown.

**Page shown only during its Activity** — page *TV*: `hiddenUnlessActivity`
`watch_tv`, `hideMode` `full`: swipes skip it while the Activity is off, and the
remote leaves it when the Activity stops.

**Hotkey event for automations** — hotkey `VOICE (Microphone)` with
`"event": "voice"`; an automation triggers on it:

```yaml
triggers:
  - trigger: event
    event_type: astrion_button
    event_data:
      event: voice
actions:
  - action: assist_satellite.start_conversation
    target:
      entity_id: assist_satellite.kitchen
```

**Apple TV compact remote with apps**:

```json
{ "type": "apple_tv_remote", "options": { "deviceId": "62846050", "layout": "compact",
  "entity": "media_player.apple_tv", "apps": [ { "source": "Netflix", "color": "#B3261E" } ] } }
```

**Device states** — profiled IR devices are started Harmony-style; the
simulator remembers which devices it believes are on (panel under the screen).
If a device was switched by hand, press **Reset device states**.

### 10. Quick push / pull and 1.2.8–1.2.9 options

**Push / Pull** are on every remote of the list and in the header of an open
remote, so a change made in the Editor or tried in the Simulator can be sent
without opening Sync. A push over a remote changed on its own side asks first.

**Hotkey popup** (blue key opens the AV page over the current one; press again to close):

```json
{ "key": "BLUE_BUTTON", "page": "AV", "pageMode": "popup" }
```

**Dock clock follows the room** — `dock.room` "Living room" and, on the
Activity, `"nowPlayingEntity": "media_player.apple_tv"`: while that Activity
runs, the docked clock shows only that player.

**Monitor with long values** and **select as a plain menu**:

```json
{ "type": "monitor", "options": { "layout": "vertical", "marquee": true,
  "entities": [ { "entity_id": "sensor.avr_audio", "name": "Audio" } ] } }
{ "type": "select", "options": { "entity_id": "input_select.scene", "layout": "dropdown", "font_size": 18 } }
```

### 11. Two histories: add-on and remote (app 1.3.0)

Since 1.3.0 the remote keeps its own history of `dashboard.json`. The add-on's
history stays the reference; the remote's is a safety net it reads and labels.

| | Add-on | Remote 1.3.0 |
| --- | --- | --- |
| Retention | Everything, forever (in HA backups) | 30 + pinned |
| Storage | Differences between versions | Full copies |
| Labels | Unique names per remote | Free notes, pins |
| Scope | All remotes, copy between them | That remote only |
| Records edits made on the remote | Only when they're found as drift | Yes, every save |

- Every push is labelled on the remote: `ACM v42 · "Before TV change"`.
- **Edit remote → Pin named versions on the remote**: pushed named versions are
  pinned there, so the remote's 30-version limit never removes them.
- Drift banner: *"Saved from the builder or web page: new lights"*,
  *"Restored on the remote from version 20261017-101500"*, …
- **History → Remote history**: compare any remote version with the head,
  download it, or **Import as version** (then push). The add-on never restores
  or deletes anything in the remote's history.

### 12. Navigation map

Open a remote: the **🗺 Navigation map** sits above the Editor. All pages are
in one row in the order the remote swipes through them, each drawn as a live
mini screen. Icons on the lines tell how a page is reached: 👋 swipe,
☝️ swipe up, 👆 tap, ✋ long press, 🎛 key ("Menu ⏱" = long press of Menu),
🎬 Activity, 🏠 Home Assistant state, ↩ back; a dashed line with ▣ opens a
popup. Click a card in a preview to edit it, or a line to open the tile or
hotkey behind it. In the Simulator, clicking a page jumps there. ▴ hides the
map; drag its bottom edge to resize it.

**Editing on the map** (Editor tab):

- drag *Home*'s right ● onto *TV*'s left ● → *TV* becomes *Home*'s swipe neighbour;
- each key appears once in the key row, with two anchors: ◧ left = this page only, ◨ right = global;
  ⚡ marks a key bound to an action that opens no page (e.g. a service): it has no link;
- drag the **right (global) ◨ anchor** of the **Play / Pause** key onto *TV*'s bottom ● → choose
  *Long* + *Popup* → `{"key": "PLAY", "page": "TV", "pageMode": "popup"}` in `longHotkeys`;
- drag the *Movie* tile of a scene grid onto *Cinema*'s top ● → choose *Tap* →
  the tile gets `"page": "Cinema"`;
- **＋ New page** / **🗑 Delete page** on the map bar add an empty page or delete the selected one;
- press and hold a connection's icon → confirm → the link is removed;
- drag a screen by its title bar to arrange the map (saved per remote, **⟲** resets it);
  **Page keys / Global keys / Links** show or hide those anchors and links.

Each change is one version: **Undo** reverts it.

### 13. Themes

**Editor → Global → Theme → 📂 Load theme** → pick *OLED black* (preview on the
right) → one new version, Undo brings the old colours back. **💾 Save as…**
stores the current colours as *Living room*. On the main screen, **Themes** →
*Living room* → **Apply to remotes…** → tick *Kitchen* and *Bedroom* → each gets
a version, ready to push. **Export** gives a file like:

```json
{ "name": "Living room", "theme": { "background": "#000000", "accent": "#4DA3FF" } }
```

that **Import from file** reads back (a whole `dashboard.json` works too).

### 14. The remote's own builder

The links open a normal new tab (no pop-up), so they also work inside Home
Assistant's frame and in the companion app.

**Open in builder ↗** (remote header) opens `http://<ip>:8080/builder/` in a new
tab at what you selected here, e.g. page *TV* → `/builder/#page=TV`, a card →
`#page=TV&card=2`, an Activity → `#activity=watch_tv`; **History ↗** opens
`#history`. Both are greyed out when the remote can't be reached (local network
only).

Prefer the builder? **Edit remote → Edit with the remote's builder**: the add-on
becomes the read-only backup. **Edit in builder** first asks to push or discard
add-on changes not yet sent; save in the builder, come back to this tab (or
press **Done**) and the change is imported as a version with the note you typed
in the builder. Changes on both sides? You choose which to keep — never merged.

### 15. Built-in weather (app 1.3.2-beta)

**Editor → Global → Built-in weather** → *Find a town* "Bracciano" → pick it →
the block below is written; then use `weather.astrion` in a clock & weather card
or the dock clock.

```json
"weather": { "name": "Bracciano", "latitude": 42.12, "longitude": 12.17, "model": "auto", "unit": "celsius" }
```

### 16. Large preview

In the Editor, the pane on the left shows the selected screen in large size with
live states; click a card in it to edit that card. Drag its right edge to resize
it, **◂** hides it (**▸ Preview** brings it back).

## Data and backups

Everything lives in the app's `/data` volume (included in HA backups):

```
/data/remotes/<id>/meta.json          remote + sync state
/data/remotes/<id>/versions/*.json    one file per version (JSON Patch)
/data/remotes/<id>/snapshots/*.json.gz full state at v1 and every 50
/data/remotes/<id>/names.json         version names
/data/icons/                          shared icon library
/data/sim_state/<id>.json             simulator device states (RF10.5)
/data/themes/<id>.json                saved themes (RF14)
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
