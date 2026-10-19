# Changelog

## 2.19.0 - 2026-10-19

- Map (RF15.3): the hardware keys are now ONE row, each key shown once, with
  two anchors: ◧ left "this page only" (selected page, overrides global) and
  ◨ right "global". Links start from the anchor of their scope; orange / blue
  edge = bound on the page / globally. The "Page keys" / "Global keys"
  switches hide that anchor and its links. Removes the duplicated key rows.

## 2.18.0 - 2026-10-19

- Map (RF15.6): big "＋ New page" and "🗑 Delete page" buttons on the map bar,
  same as the editor's. The new page is selected; deleting asks first and says
  how many links point to the page; startPage follows; undoable.

## 2.17.0 - 2026-10-19

- Fix (RF16.3): global keys appeared twice on the map, in the "Global keys" row
  and in the "Any page (global keys)" box. With the row shown, that box now only
  stands for the swipe down ("Any page · swipe down").
- Map key chips: keys with a binding stand out (tooltip shows what they do),
  unbound keys are dimmed; row titles say that page keys override the global
  ones.

## 2.16.0 - 2026-10-19

Spec v1.15 (RF17).

- Fix: "Open in builder", "History" and "Edit in builder" are now real links
  (new tab on click) instead of script-opened tabs, which Home Assistant's
  frame / companion app blocked as pop-ups. In native mode with unsent changes,
  Push / Discard comes first, then a dialog with the link.
- Large preview pane on the left of the Editor: the selected screen, live,
  click a card to edit it, resizable and hideable (remembered).

## 2.15.0 - 2026-10-19

Aligned with astrion-custom-dashboard **1.3.2-beta** (1.3.1-beta included);
spec v1.14 (RF16).

- Push uses `X-Astrion-Version-Id` (1.3.1-beta) to pin/label its remote
  version; note matching kept for 1.3.0 (RF16.1).
- Built-in weather (1.3.2-beta): Global section with town search through the
  remote, validation, `weather.astrion` accepted as entity (RF16.2).
- Map: screens draggable (layout saved per remote, Reset), switches for page
  keys / global keys / links plus per-kind toggles, key chips with the
  simulator's icons (RF16.3).
- "Open in builder ↗" / "History ↗": the remote's builder in a new tab at the
  editor's selection (deep links), greyed out when unreachable (RF16.5).
- Mode "Edit with the remote's builder" per remote: add-on read-only backup,
  push/discard before opening, automatic import with the builder's note on
  return, explicit choice when both sides changed (RF16.4).

## 2.14.0 - 2026-10-18

Spec v1.13 (RF15): the navigation map becomes editable (Editor tab).

- Screen anchors: left/right = swipe order (drag A.right onto B.left moves B
  after A; startPage follows its page), top = tile jumps, bottom = hotkeys.
- Hardware key chips under the map: keys of the selected page and global keys;
  drag a chip onto a screen → short/long, page/popup → hotkey (replace asked).
- Drag a button_grid / scene_grid tile (also inside rows) onto a screen → tap /
  long tap, page/popup (replace asked; Activity tiles warned).
- Press and hold a connection to remove it (tap, long tap, hotkey, swipe up,
  back, HA state); swipe, Activity and overlay links explain why they can't.
- Every change is one undoable version. Pure document functions covered by
  Node tests (tests/map_mutations.test.js).

## 2.13.0 - 2026-10-18

Spec v1.12 (RF13, RF14).

- Navigation map above the Editor and the Simulator (RF13): live mini preview
  of every page, one row in swipe order, icons per way to reach a page (swipe,
  swipe up, tap, long press, key, Activity, HA state, swipe down, back; dashed
  = popup), special boxes for global keys, Home Assistant, Activities and
  Settings, missing-page warnings, legend. Zoom / pan / fit, collapsible and
  resizable (remembered). Click a page, a card or a link to edit it; in the
  Simulator a click jumps to the page.
- Theme library (RF14): presets Default / Light / OLED black / High contrast;
  Load / Save as / Delete in Editor → Theme (load = one undoable version);
  Themes tab with preview, rename, duplicate, delete, export, import (checks
  colours) and apply to several remotes.
- Fix (RF13.8): the simulator's horizontal swipe runs over all pages in file
  order like the remote (it was limited to pages with the same parent); the
  dots still show only the siblings.

## 2.12.0 - 2026-10-17

Aligned with astrion-custom-dashboard **1.3.0** (stable; dashboard format
unchanged since 1.2.9-beta) and integrated with its new version history;
spec v1.11 (RF12).

- Every push sends a note to the remote's history: `ACM v<n>` plus the
  version name (RF12.1).
- Option per remote "Pin named versions on the remote" (RF12.2).
- Drift banner explains the change from the remote's newest history entry
  (restored, changed outside the web page, saved from the builder) (RF12.3).
- History tab: "Remote history" panel — reason, note, pins, pushed-by-add-on
  marker; compare with head, download, import as version (origin kept; the
  remote's current file re-syncs like a pull) (RF12.4).
- The add-on never restores/deletes on the remote; no automatic mirroring;
  apps older than 1.3.0 unaffected (RF12.5–RF12.7).

## 2.11.0 - 2026-10-16

Aligned with astrion-custom-dashboard **1.2.9-beta** (incl. 1.2.8-beta); spec
v1.10 (RF11).

- Pull and Push buttons on every remote of the list and in the header of the
  open remote (all tabs); a push over a drifted remote asks first (RF11.8).
- Hotkey `pageMode: "popup"`: editor dropdown; simulator opens the page as a
  popup and the same key closes it (RF11.1).
- Monitor `layout: "vertical"` and `marquee` (RF11.2).
- `nowPlayingEntity` on Activities, tracked tiles and hotkeys; `dock.room`; the
  simulator's dock clock follows the room's Activity player (RF11.3).
- Select `layout: "dropdown"` and `font_size` (RF11.4).
- TV remote: volume row (`show_volume`, to `mute_entity`), default media
  entity and default apps as upstream (RF11.5).
- Icons: `source_select.icon`, PNG icons on switch / picture elements,
  `on_color` per picture element (RF11.6).
- Simulator: long MAIN opens Settings when no hotkey does (RF11.7).

## 2.10.0 - 2026-10-14

Aligned with astrion-custom-dashboard **1.2.7-beta** (`dev` branch; latest
stable still 1.2.0); spec v1.9 (RF10).

- Editor: "Dock screen" (`dock`) and "Standby & battery" (`power`) sections,
  with range/value warnings and entity checks (RF10.1).
- Pages: `hideMode` dropdown (`dots` / `full`); simulator skips `full` pages on
  swipes and leaves them when their Activity stops; `dots` pages stay swipeable
  with no dot, as upstream (RF10.2).
- `stopActivity` (room or `*`) on tiles, buttons, long_press and hotkeys with a
  room dropdown; hotkey `event`, `openOverlay`, `openCurrentActivityRoom`;
  hardware keys shown as "Menu (MAIN)" (RF10.3).
- `apple_tv_remote`: layouts classic/compact/full, `entity`, artwork/progress/
  skip switches, `apps` list editor, 14 buttons; simulator renders the layouts
  and launches apps with `media_player.select_source` (RF10.4).
- Composed Activities: port of the upstream ActivityPlanner (ir-database
  profiles, Harmony-style start) with a per-remote device-state memory and a
  "Reset device states" button (RF10.5).
- IR lookup as the app: loose command ids, "(Harmony)" model suffix, split
  Pronto repair, `repeats` with the repeat burst (RF10.6).
- Real execution of `stopActivity` (composed stop / Harmony PowerOff) and of
  hotkey events (`astrion_button` on HA's bus) (RF10.7).
- Simulator "Docked" switch: dock screen preview (RF10.8).
- Remote identity from `/info` in the list; duplicates flagged (RF10.9).
- Icons: deletion also on the remotes that don't use them (RF10.11).
- Drift banner lists the changed keys and flags changes made from the remote's
  own Settings screen (RF10.12).
- Tooling: `tools/gen_i18n.py` regenerates the UI strings from
  `static/i18n_source.tsv`.

## 2.9.0 - 2026-10-08

Aligned with astrion-custom-dashboard **1.2.1-beta**, and re-checked against
**1.2.0**; spec v1.8 (RF9.6, RF9.7).

- 1.2.1-beta: `long_press` block on `button_grid` buttons and `scene_grid`
  tiles. Editor: "Long-press action" toggle with its own form (service,
  entity, Harmony, hub, IR, Activity, page/popup, closePopup). Entities inside
  are validated; copying rewrites its page and IR references; a non-object
  value is a warning. Simulator: hold a tile to fire it (hub falls back to the
  tile's own, `entity_id` alone = `turn_on`, as upstream).
- 1.2.0 recheck: any service call on a paired Apple TV entity (not only
  `astrion_appletv.*`) is handled by the remote itself, so the simulator no
  longer forwards it to Home Assistant (it shows the reason instead).
- 1.2.0 recheck: `media_controls` / `volume_controls` are comma lists:
  checkbox editor (empty = none, absent = default), unknown keys warned, and the
  simulator draws exactly the configured controls (incl. on_off, shuffle,
  repeat, volume slider).
- 1.2.0 recheck: `openWhenState` absent means the literal state `"on"`.
- Fix: in the simulator a tap could be lost when a Home Assistant state update
  arrived during the press (the tile was redrawn before the click).

## 2.8.0 - 2026-10-08

- Monitor card (and every list editor): items no longer collapse after each
  edit (open items are remembered); new items open automatically; short item
  forms (monitor entities, speakers, tv_remote apps-like rows of <=3 fields)
  are always expanded; empty "Other fields" boxes hidden in list items.
- monitor / speaker_group rows written as plain strings (skipped by the remote,
  which reads `{"entity_id", "name"}`) get a warning and a one-click "Convert".
- Simulator: monitor and speaker_group skip non-object rows like the remote.

## 2.7.0 - 2026-10-08

Aligned with astrion-custom-dashboard **1.2.0**; spec v1.7 (RF3.6, RF9).

- Direct Apple TV (1.2.0): paired Apple TVs read from the remote (credentials
  never stored); their `media_player.appletv_*` entities are valid; the
  `apple_tv_remote` editor offers "Control via: Apple TV (direct) / Harmony hub"
  (both ways still supported, `appleTv` wins with a warning); `buttons`
  multi-select. Simulator shows direct Apple TV actions disabled with the reason.
- Push: the Apple TV catalog entries the 1.2.0 remote adds to `haDevices` are
  added first as a `sync-import` version, so push verification succeeds.
- Structured list editors (add/reorder/duplicate/remove, item forms with
  entity, icon, colour, page, hub, IR, activity pickers): button_grid buttons,
  scene_grid scenes, tv_remote apps, monitor entities, speaker_group speakers,
  picture_elements elements; `row.cards` nests full card forms.
- Card schema regenerated from 1.2.0 with `tools/extract_card_schema.py`, which
  now types `options[...] as? Boolean/Number` fields (e.g. scene_grid
  show_labels/icon_fill become checkboxes, climate/fan step numbers).
- Simulator: picture_elements follows upstream (left/top %, entity toggle or
  service on targets).

## 2.6.0 - 2026-10-05

- Theme form: keys absent from `dashboard.json` now show the remote's built-in
  default (ThemeConfig) in the swatch and as placeholder, instead of black/empty.
  A short note explains that the theme is part of `dashboard.json`.

## 2.5.0 - 2026-10-05

- Fix: after an update the browser / HA companion app could keep running the
  previous editor code from cache (e.g. no dropdowns or colour palettes after
  2.4.0). Asset URLs now carry `?v=<version>`, the page is served `no-store`
  and static files `no-cache`.
- The panel header shows the running version.

## 2.4.0 - 2026-10-05

Spec v1.6, RF3.5.

- Fixed-value fields are dropdowns with the values of the upstream web builder
  (alignment, layout, style, mode, fit, variant, artwork, iconPosition,
  time_format, ...) plus "default"; camera aspect offers presets and a free number.
- Colour fields (title color, select icon_color, switch on_color) and the whole
  theme get a palette + hex input; #AARRGGBB alpha is kept when picking.
- JSON editors: "Insert colour" (e.g. scene color / active_color).
- Out-of-list values and malformed colours are non-blocking warnings.

## 2.3.0 - 2026-10-05

Spec v1.5, new RF8: multiple Harmony hubs and IR targets, as on the remote.

- Hubs and IR extenders read from the remote (`/devices-config`) at registration,
  on pull and with Refresh; read-only; the remote's HA token is never stored.
- Harmony: action `hub` selects the hub by localId, else the first hub; known
  hub ids skip discovery; old single Hub IP kept as fallback.
- IR: `local` target -> HA `remote.*` entity (Broadlink); extender targets ->
  `POST http://<host>/pronto`; inline codes converted to Pronto.
- Editor: hub and IR target dropdowns; unknown extender = error, unknown hub = warning.
- Simulator: hub/extender named in errors and in Navigation only.

## 2.2.0 - 2026-10-05

Spec v1.4, new RF7 (the remote's home-page utilities).

- Shared icon library (Icons tab): upload PNG/JPEG/WebP, delete from library,
  import the icons already stored on a remote.
- Push uploads the icons used by the head that the remote does not have.
- Icon fields: thumbnail + picker; JSON editors: "Insert icon" at the cursor.
- Missing icons (neither in library nor on the remote) block push.
- `haDevices` entity catalog form; catalog names suggested (★) in entity fields;
  catalog entities validated against HA; copied with pages/cards.
- Simulator shows custom icons; fix: cards no longer shrink on long pages.

## 2.1.0 - 2026-10-05

- Simulator: scroll position of long pages is kept across live state updates
  (the screen was rebuilt on every HA event and jumped back to the top).
- Simulator: swipes. Mouse drag and touch both work; vertical touch scrolling is
  native again; swipe-up opens the linked page only when the page is scrolled to
  the bottom; sliders no longer trigger swipes; a swipe never also taps a tile.
- New "Navigation only" switch (spec RF6.12): actions are listed, not executed.
- Spec updated to v1.3 (RF6.12), IT and EN.

## 2.0.0 - 2026-10-05

Phase 2 of the specification (RF6): the requirement is now fully implemented.

- Simulator tab: screen sized on the remote's resolution/orientation, swipe pages,
  linked pages and popups, `openWhenEntity`, `hiddenUnlessActivity`, parent/back key.
- Renderers for all 21 upstream card types; unknown cards shown as "cannot be simulated".
- Live HA state (get_states + state_changed) through the app's websocket.
- Real execution: HA service calls, Harmony Hub (local protocol, port 8088),
  IR via the remote's `remote.*` entity (Broadlink `b64:` codes, inline or ir-database).
- Composed Activities (power on/off diff, input commands, delays) as on the remote.
- HA100 physical keys panel with short and long press hotkeys.
- Actions needing an unconfigured Hub IP or IR entity are disabled with the reason.

## 1.1.0 - 2026-10-05

- Docs: English translation of the specification (`SPEC.en.md`), linked from both READMEs and from the Italian spec.
- No functional changes.

## 1.0.0 - 2026-10-05

First release (spec v1.2, phase 1: RF1-RF5).

- Remote registry with archive (RF1).
- Linear delta version history: undo/redo, restore, named versions (RF2).
- Form editor + raw JSON, lossless round-trip, copy pages/cards between remotes (RF3).
- Structural and HA entity validation; push blocked on errors (RF4).
- Pull/push with canonical-hash drift detection and post-push verification (RF5).
- UI in English, Italian, French, Spanish, German.

Not included yet (v2.0): simulator, Harmony Hub and Broadlink IR execution (RF6).
