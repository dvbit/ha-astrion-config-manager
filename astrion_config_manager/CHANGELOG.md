# Changelog

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
