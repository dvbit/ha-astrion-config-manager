# Changelog

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
