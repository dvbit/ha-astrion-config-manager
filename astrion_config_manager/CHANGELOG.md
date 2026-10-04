# Changelog

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
