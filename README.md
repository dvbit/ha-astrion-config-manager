<img src="astrion_config_manager/logo.png" alt="Astrion Config Manager" width="250">

# Astrion Config Manager

Home Assistant **app (add-on)** for **Astrion HA100** remotes running
[astrion-custom-dashboard](https://github.com/dckiller51/astrion-custom-dashboard):
a full-screen **map of the pages**, **page linking** by drag and drop, a
full-screen **navigation test**, and the remote's own **builder** embedded in
Home Assistant.

🇮🇹 [Versione italiana](README.it.md) · 📄 Specification: [English](SPEC.en.md) · [Italiano](SPEC.md)

> **3.0 — scope change.** The Astrion app's own builder now does single-screen
> editing very well, so the add-on no longer duplicates it. The form editor and
> the add-on's version history are gone: each screen is edited in the builder
> (embedded in the **Builder** tab), and the remote keeps the history (app 1.3.0+).
> What stays here is what the builder doesn't do: the whole navigation at a
> glance, linking pages, and testing the navigation. See
> [what changed](#what-changed-in-30).

## Installation

1. **Settings → Apps (Add-ons) → App store → ⋮ → Repositories**
2. Add `https://github.com/dvbit/ha-astrion-config-manager`
3. Install **Astrion Config Manager**, start it, open **Astrion** in the sidebar.

On each remote, enable the app's **config server** (port 8080, settings page).
Follows upstream **1.5.8-beta** (works with 1.5.x; the screens are drawn by the
builder installed on each remote, so new card types appear automatically).

## Features

| Area | What you get |
| --- | --- |
| Map | Every page drawn by the remote's own builder renderer, one icon per way to reach it (👋 swipe, ☝️ swipe up, 👆 tap, ✋ long press, 🎛 key, 🎬 Activity, 🏠 HA state, 🧩 card page, ↩ back; dashed ▣ = popup). Zoom, pan, drag screens, ⇅ hierarchy layout, sibling bands, ①②③ swipe order. |
| Linking | Drag one screen onto another: a chooser asks which element opens it — a tile/button (tap or long press), a hardware key (this page or global, short or long), swipe up, or parent (Back) — page or popup, and shows what it replaces. |
| Cutting | Press and hold a link's icon to remove it (card-level links such as the media remote's ⋯ page can be cut too). |
| Writes | Straight to the remote with a note (`ACM: Home → TV · Tap "TV"`); refused if the remote changed since it was loaded. Undo = the remote's history (Builder → 🕘 History). |
| Simulate | Full-screen navigation test: tap / hold tiles, swipe on the screen, HA100 keys, popups at their size and position, Activities overlay. Nothing is sent to your devices. |
| Builder | The remote's builder inside the add-on (works over HTTPS). Saving there refreshes the map and the simulation at once. |
| Themes | Shared theme library with presets: preview on your remote, export, import, apply to several remotes. |
| Icons | Shared icon library (backed up). |
| Languages | English, Italian, French, Spanish, German (follows your HA language). |

## Usage examples

### 1. Register a remote

**＋ Add remote** → name *Living room*, IP `192.168.2.50`, port `8080`, size
`480×800`, portrait → **Register**. The remote must be reachable.

### 2. Read the navigation

**🗺 Open** → all pages in swipe order. *Home* → 👆 *TV* means a tile on Home opens TV;
a dashed line with ▣ opens a popup. **⇅ Arrange by hierarchy** puts child pages under
their parent (⟲ back to one row).

### 3. Link two pages

Drag the *Home* screen onto *TV* → choose:

- **Tile / button** *TV* · *Tap* · open as *Page* → the tile gets `"page": "TV"`;
- or **Hardware key** *Play / Pause* · *Long* · *Global* · *Popup* →
  `{"key": "PLAY", "page": "TV", "pageMode": "popup"}` in `longHotkeys`;
- or **Swipe up** → `"linkedPage": "TV"` on Home;
- or **Parent** → Home becomes a child of TV (Back key, dots group).

**Link** → written to the remote with the note `ACM: Home → TV · …`. Dragging from a
tile preselects that tile. Side ● anchors still change the swipe order.

### 4. Cut a link

Press and hold a link's icon → **Remove** → written to the remote.

### 5. Test the navigation

**▶ Simulate** → the remote's screen full size. Tap *TV*, hold a tile for its long
press, swipe left / right / up (linked page) / down (Activities), press **↩**.
Actions that are not page changes are only named (*not executed*).

### 6. Edit a screen

**🛠 Builder** → the remote's builder opens on the page selected on the map. Save:
the map and the simulation update at once. **🕘 History** opens the remote's history
(undo a link written by the add-on there).

### 7. Themes

**Themes** → *OLED black* → **Apply to remotes…** → tick *Kitchen* → written to the
remote (`ACM: theme OLED black`). **Export** gives:

```json
{ "name": "Living room", "theme": { "background": "#000000", "accent": "#4DA3FF" } }
```

## What changed in 3.0

| Removed | Use instead |
| --- | --- |
| Form editor, big preview, card copy | The remote's builder (**Builder** tab) |
| Add-on versions, undo/redo, named versions, restore | The remote's history (Builder → 🕘 History) |
| Push / pull, drift, "edit with the builder" mode | Every change is written straight to the remote |
| "Simulate & run" (real device actions) | Navigation-only test |

Existing data in `/data` (old versions) is left untouched.

## Data and backups

`/data` (included in HA backups): `remotes/<id>/meta.json` (remote, map layout),
`icons/` (icon library), `themes/` (saved themes). Versions written by 2.x stay
on disk, unused.

## Logging

Option `log_level` (`trace`…`error`). INFO: writes to the remotes (with note), builder
saves seen by the proxy, remote registration. WARNING: write refused (remote changed),
remote unreachable, proxy errors. DEBUG: proxied requests, live reads.

## Development

```bash
pip install -r astrion_config_manager/requirements.txt pytest pytest-aiohttp ruff
pytest -q && ruff check .
cd astrion_config_manager/app && ACM_ALLOW_ANY=1 ACM_DATA_DIR=/tmp/acm python3 -m acm
```

CI workflows are in `ci/` (move to `.github/workflows/`).

## License

GPL-3.0, like the upstream project.
