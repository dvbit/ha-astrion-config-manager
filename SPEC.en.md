# Requirement — Astrion Config Manager (HA add-on) v1.19

> English translation of [SPEC.md](SPEC.md). The Italian document is the
> reference; in case of discrepancy the Italian text prevails.

Status: approved by the requester. v1.3: added RF6.12 (navigation-only mode). v1.4: added RF7 (icons and entity catalog). v1.5: added RF8 (multiple Harmony hubs and IR targets). v1.6: added RF3.5 (dropdowns and palettes). v1.7: added RF3.6 (structured lists) and RF9 (upstream 1.2.0, direct Apple TV). v1.8: RF9.6–RF9.7 (upstream 1.2.1-beta and 1.2.0 recheck). v1.9: RF10 (upstream 1.2.2–1.2.7-beta). v1.10: RF11 (upstream 1.2.8–1.2.9-beta, push/pull on the main screen). v1.11: RF12 (upstream 1.3.0, integration with the remote's version history). v1.12: RF13 (navigation map) and RF14 (theme library). v1.13: RF15 (editable navigation map). v1.14: RF16 (upstream 1.3.1–1.3.2-beta, map layout and switches, the remote's builder). v1.15: RF17 (large preview pane, builder opened by a link). v1.16: RF15.3 one key row with two anchors. v1.17: RF18 (Editor and Simulator merged). v1.18: RF19 (upstream 1.3.3-beta, tile anchors). v1.19: RF20 (hierarchy view of the map). Supersedes v1.0: Harmony and IR are now in scope; named versions added (RF2.11–RF2.13). Original document language: Italian.

## 1. Purpose

Home Assistant add-on with an Ingress panel that manages the configurations (`dashboard.json`) of one or more Sanytron Astrion HA100 remotes running the *Astrion Custom Dashboard* app (repo `dckiller51/astrion-custom-dashboard`). It provides: a form editor, a delta version history with undo/redo, synchronisation with the remotes, and a simulator that reproduces the remote's behaviour and executes the real actions (Home Assistant, Harmony Hub, IR emitter).

## 2. Scope

**Included:** remote management, editor (including Harmony and IR), versions, validation, pull/push, detection of external changes, simulator. **Excluded:** the remote's connection settings towards HA and the Hub (they stay on the device); updating the remote's app; automatic discovery of remotes; permanent deletion of data.

## 3. References

- Reference schema: `dashboard.json` as defined by the most recent release of the repo at development time (last observed: 1.3.0 stable, 1.3.3-beta). Card and action behaviour: Kotlin sources (`cards/impl/`, `config/DashboardLoader.kt`) and web editor (`docs/index.html`, `cards.js`).
- Remote: the device exposes no API. The add-on issues the same HTTP requests as the browser on the configuration page `http://<host>:<port>` (download and upload of `dashboard.json`), derived from the repo's `web/` sources. Editing happens only in the add-on's web interface.
- Home Assistant: WebSocket API via the add-on's Supervisor token; no token entered by the user.
- Harmony Hub: the Hub's local protocol as used by the app's Harmony client (Kotlin sources of the repo).
- IR: HA `remote.*` entity with the `send_command` service.

## 4. Glossary

- **Remote**: an instance registered in the app, with its own history.
- **Version**: the complete state of a `dashboard.json`, stored as a delta from the previous one.
- **Head**: the latest version of a remote.
- **Baseline**: hash of the content of the last successful pull or push.
- **Drift**: content on the device whose hash differs from the baseline.

## 5. Functional requirements

### RF1 — Remotes

- RF1.1 Manual registration only. Mandatory fields: name (unique among non-archived remotes), host/IP, port (default 8080), screen width and height in pixels, orientation (portrait/landscape); no default for size and orientation. Optional fields: Harmony Hub IP address, HA `remote.*` IR emitter entity.
- RF1.2 Registration performs an initial pull: if it succeeds it creates version 1 (type `import`); if it fails (device unreachable or file missing) it shows the error and does not register.
- RF1.3 All fields can be edited after registration.
- RF1.4 Removing a remote archives it: it disappears from the main list, history and data remain intact, and it can be restored from an "Archived" view. There is no permanent deletion.
- RF1.5 Multiple remotes with independent histories.

### RF2 — Versions

- RF2.1 Each version has: a progressive integer id per remote, parent id, timestamp, HA user, type (`import`, `edit`, `undo`, `redo`, `restore`, `sync-import`), delta.
- RF2.2 Linear append-only history: no version is ever modified or deleted; no branching.
- RF2.3 A version is created on every field commit (loss of focus or Enter) that produces a non-empty delta. A commit without changes creates no version. Every structural operation (adding, removing, reordering, copying a page/card/hotkey) and every application of the raw JSON editor is a single version.
- RF2.4 **Undo**: creates a version of type `undo` whose state is the one preceding the last undoable version not yet undone. Versions of type `edit`, `restore`, `import`, `sync-import` are undoable. Repeated undo goes further back (LIFO order).
- RF2.5 **Redo**: creates a version of type `redo` that restores the last undone version. Available only if no version other than `undo`/`redo` has been created after the last undo; any new edit, restore or import clears the redo.
- RF2.6 **Restore**: the user picks any version from the history and restores its state in one step, creating a `restore` version.
- RF2.7 The history can be browsed: list of versions with type, date, user and summary of the changes (readable delta).
- RF2.8 Storage: deltas only, in JSON Patch format (RFC 6902) relative to the previous version. Exception to limit the reconstruction cost: complete compressed snapshot at version 1 and every 50 versions.
- RF2.9 Unlimited retention, no compaction.
- RF2.10 Concurrency: every commit carries the id of the head seen by the client; if the head has changed the commit is rejected, the UI realigns and informs the user.
- RF2.11 **Named versions**: the user can give a name to any version, not only the head. The name is not empty, is unique per remote (case-insensitive) and each version has at most one.
- RF2.12 The name is a label separate from the version: assigning, renaming or removing it creates no versions and does not alter the history; removing the name does not delete the version. Names are kept even when the remote is archived.
- RF2.13 From the list of names the labelled version is restored with the rules of RF2.6 (creates a `restore` version). The history list shows the names and allows filtering only the named versions.
- RF2.14 The remote's own history (app 1.3.0) complements this one without replacing it: see RF12.

### RF3 — Editor

- RF3.1 Form editor for pages, cards and hotkeys, for all card types, fields and actions present in the reference schema (§3), including Harmony and IR cards and actions (IR devices and their codes included).
- RF3.2 Lossless round-trip: unknown cards, fields and actions remain intact in the saved file and can be edited as raw JSON. Key order is not guaranteed; the content is semantically identical.
- RF3.3 Copying pages and cards from one remote to another: creates a single version in the destination remote. Key/id collisions in the destination are resolved with a numeric suffix, updating the internal references to the copied elements.
- RF3.5 Fixed-value fields (e.g. `alignment`) are dropdowns with the values documented by the reference implementation and a "default" option that removes the key. Colour fields (cards and theme) have a palette plus the hex value (#RRGGBB or #AARRGGBB, alpha preserved). JSON editors can insert a colour. Out-of-list values or malformed colours are warnings, not errors.
- RF3.6 List options have per-item forms with add, reorder, duplicate and remove: `button_grid.buttons`, `scene_grid.scenes`, `tv_remote.apps`, `monitor.entities`, `speaker_group.speakers`, `picture_elements.elements`. `row.cards` holds nested cards with their full form. This covers the cards with no form in the native builder (`monitor`, `picture_elements`, `row`, `source_select`, `speaker_group`).
- RF3.4 Tokens and secrets present in the JSON are stored in clear text in the history and shown unmasked (risk accepted by the requester).

### RF4 — Validation

- RF4.1 Structural errors: invalid JSON, missing mandatory fields or wrong types in the known parts of the schema, including the Harmony and IR parts.
- RF4.2 HA entities: every `entity_id` referenced in known fields must exist in HA.
- RF4.3 For Harmony and IR, structural check only: no check that activities, devices or commands exist on the Hub, nor that the IR emitter exists.
- RF4.4 Validation runs on every change and shows errors inline; it does not prevent creating versions.
- RF4.5 Push is blocked if the head contains any error or non-existent HA entity.

### RF5 — Synchronisation

- RF5.1 **Pull**: downloads `dashboard.json` from the device; if it differs from the head it creates a `sync-import` version and updates the baseline.
- RF5.2 **Drift check**: performed when the panel opens (for every non-archived remote) and immediately before every push. It compares the SHA-256 hash of the device's canonical JSON (sorted keys, normalised whitespace) with the baseline. Device unreachable: "unreachable" status, push impossible.
- RF5.3 Drift is only reported, push is not blocked. The user chooses: *import as version* (`sync-import`, updates the baseline), *overwrite with the head* (push), *ignore* (the warning reappears at the next check).
- RF5.4 **Push**, in order: validation (RF4.5), drift check (RF5.2), upload of the head, re-read and hash verification. If it matches, it updates the baseline and records the version and date of the last push; otherwise it reports an error and does not update the baseline.
- RF5.5 For each remote the list shows: drift status, head version, last pushed version.

### RF6 — Simulator

- RF6.1 Simulates the head of the selected remote (not historical versions) and updates on every new version.
- RF6.2 Screen with the remote's width, height and orientation (RF1.1), scaled to fit the panel, with swipe-navigable pages.
- RF6.3 Every known card type, including Harmony and IR ones, is rendered visually faithful to the remote's app. Unknown cards: placeholder with the type and a "cannot be simulated" note.
- RF6.4 Live state: cards show the current state of the referenced HA entities (on/off, values), updated in real time. Page visibility and opening conditions (`openWhenEntity`, `hiddenUnlessActivity`) are evaluated on the live state.
- RF6.5 An action that resolves to an HA service call is **always really executed** on HA with the same services and data the remote's app uses. Errors are shown.
- RF6.6 Navigation actions (page change, linked pages, overlays) are simulated in the simulator.
- RF6.7 Harmony action: really executed, directly towards the Hub at the remote's IP (RF1.1), with the same protocol as the app. Without a configured Hub IP the action is disabled with the reason shown; sending errors are shown.
- RF6.8 IR action: really executed through the remote's `remote.*` entity (RF1.1) with `send_command`; the add-on converts the configuration's IR codes into the format accepted by the entity. Without a configured entity the action is disabled with the reason shown; errors are shown.
- RF6.9 Panel with the HA100's physical buttons, clickable: they execute the configured hotkey with the same rules as RF6.5–RF6.8.
- RF6.10 The simulator shows a permanent indicator "Real execution: Home Assistant, Harmony Hub, IR".
- RF6.12 (since v1.17 the **▶ Simulate** button, RF18) "Navigation only" switch: when on, actions (HA, Harmony, IR) are not executed, only listed; navigation, linked pages, popups and composed Activities (updated locally) are still simulated. The RF6.10 indicator shows the mode. Default: off.
- RF6.11 The simulator reproduces the behaviour the app has on the remote (conditional visibility of pages and cards, linked pages, overlays, popups, response to physical buttons), not just command sending. The editor is for designing the configuration; testing happens only in the simulator.

### RF7 — Icons and entity catalog

- RF7.1 Shared icon library in the add-on (PNG, JPEG, WebP, max 2 MB), included in HA backups. File names are normalised with the same rule as the remote.
- RF7.2 Deleting an icon removes it from the library; since app 1.2.7 it can also be deleted on the remotes (RF10.11).
- RF7.3 On push, icons used by the head and missing on the remote are uploaded from the library before the file. Icons present on a remote can be imported into the library.
- RF7.4 Every icon field of the editor has a thumbnail and a picker (library + remote icons); JSON editors can insert an icon path. The simulator shows the real icons. An icon missing from both the library and the remote is an error that blocks push.
- RF7.5 Form for the `haDevices` catalog (name, type, HA entity filtered by type). Catalog entries are offered in the editor's entity fields. A catalog entity that does not exist in HA blocks push.
- RF7.6 Copying pages/cards between remotes also copies the catalog entries of the entities they use.

### RF8 — Multiple Harmony hubs and IR targets

- RF8.1 Harmony hubs and IR extenders are read from the remote (`GET /devices-config`) at registration, on every pull and with the Refresh button. They are read-only. The HA token contained in the response is discarded and never stored.
- RF8.2 An action's `hub` field selects the hub by `localId`; missing or unknown uses the first hub, as in the reference implementation.
- RF8.3 The remote's Harmony Hub IP stays as a fallback when the remote has no hubs; the IR emitter entity is the `local` target, because the built-in blaster cannot be driven remotely.
- RF8.4 An IR device with `target: {"extender": id}` is sent directly to that extender (`POST http://<host>/pronto`, Pronto body as text/plain).
- RF8.5 Towards an extender, ir-database codes are sent as is; inline codes are converted to Pronto.
- RF8.6 In the editor `hub` and the IR target are dropdowns. An unknown extender is an error that blocks push; an unknown hub is only a warning.
- RF8.7 The simulator names the hub or extender used in error messages and in "Navigation only".

### RF9 — Alignment with upstream 1.2.0 (direct Apple TV)

- RF9.1 Paired Apple TVs are read from `/devices-config` (localId, name, entity only); pairing credentials are never stored.
- RF9.2 The `media_player.appletv_*` entities of paired Apple TVs are valid even though they do not exist in HA.
- RF9.3 `apple_tv_remote` supports both ways: direct (`appleTv`) and Harmony (`deviceId`/`hub`); the editor offers "Control via". When both are set `appleTv` wins (warning).
- RF9.4 Before a push the `appletv_<localId>` entries are added to the `haDevices` catalog as a `sync-import` version, with the same logic as the remote, so push verification stays consistent.
- RF9.5 Direct Apple TV control cannot be executed by the add-on: the simulator shows it disabled with the reason. This covers `astrion_appletv.*` and any service on a paired Apple TV's entity, which the remote handles locally.
- RF9.6 (1.2.1-beta) Every `button_grid` button and `scene_grid` tile can carry a `long_press` block with the same action fields; dedicated editor form, validation of the entities inside, copy with reference rewriting, simulator long press (fallback hub = the tile's own).
- RF9.7 `media_player.media_controls`/`volume_controls` are comma lists (empty string = no controls, key absent = default): checkbox editor, faithful simulator. `openWhenState` defaults to `"on"`.

### RF10 — Alignment with upstream 1.2.2–1.2.7-beta

Reference: astrion-custom-dashboard `dev` branch, 1.2.7-beta (latest stable 1.2.0). Every key is optional; an older app ignores it.

- RF10.1 `dock` block (mode charging/clock/dashboard, idle_seconds, brightness, night_brightness, time_format 12/24, weather_entity, media_entities, show_battery) and `power` block (motion_wake_minutes, screen_off_filter_seconds, screen_off_entities, dock_debounce_seconds, screen_timeout_seconds): "Dock screen" and "Standby & battery" sections in Global. Type, range and value errors are warnings (the remote ignores the value); the entities inside are checked like any other.
- RF10.2 Page `hideMode` (`dots` default, `full`): dropdown. With `full` and the Activity off, the simulator skips the page on swipes and leaves it (to its parent, else the nearest visible page) when its Activity stops. With `dots` the page stays reachable by swipe and only its dot is hidden. `hideMode` without `hiddenUnlessActivity` is a warning.
- RF10.3 `stopActivity` (a room, or `*` for every room) on tiles, buttons, `long_press` and hotkeys: room dropdown (rooms of the Activities and of `track` tiles). Unknown room = warning. Hotkey `event`, `openOverlay`, `openCurrentActivityRoom`, `track`/`room`/`devices`. Hardware keys are shown as "Menu (MAIN)".
- RF10.4 `apple_tv_remote`: `layout` classic/compact/full, `entity`, `showArtwork`/`showProgress`/`showSkip`, `apps` list (source, label, icon, color), 14 buttons of the upstream catalog (compact default: Menu, −10 s, +10 s, Home). The simulator renders the three layouts; apps are launched with `media_player.select_source` on `entity` (else the direct Apple TV).
- RF10.5 Composed Activities follow the upstream ActivityPlanner: with ir-database `profile` (power discrete/toggle/none, timing, repeats, named inputs as key sequences) Harmony-style start (power off unused room devices, staggered power on, inputs once ready, only when they change); otherwise the original per-device order. The simulator keeps a device-state memory per remote (on/off, input, active Activities, tracked rooms) in the add-on data; it is the add-on's own belief, not the remote's, and can be cleared with "Reset device states".
- RF10.6 IR lookup as the app: loose command ids (case, spaces, `_`, `-`), model names with or without " (Harmony)", repair of Pronto codes split across `pronto`/`pronto_repeat`, `repeats` with the repeat burst (max 1.9 s).
- RF10.7 Real execution of `stopActivity` (composed stop or Harmony PowerOff of the tracked hub; `*` = every running room) and of hotkey `event` (`astrion_button` on HA's bus with remote_id, remote_name, event, key, long, page).
- RF10.8 Simulator "Docked" switch: preview of the dock screen (charging = dimmed to near zero, dashboard = dimmed to `brightness`, clock = clock face with date, weather, battery and now playing; night = `night_brightness`, amber).
- RF10.9 Remote identity from `GET /info` (name, model, app version), read-only, shown in the list; two entries for the same physical remote are flagged.
- RF10.10 The remote's name is not changed by the add-on.
- RF10.11 Deleting an icon offers deletion also on the remotes that hold it (`DELETE /icons/<name>`); remotes whose head still uses it cannot be selected.
- RF10.12 The drift banner lists the changed keys; when only keys written by the remote's own Settings screen changed (`dock.mode`, `power.screen_timeout_seconds`) it says so.

### RF11 — Alignment with upstream 1.2.8–1.2.9-beta, quick sync

- RF11.1 Hotkey `pageMode: "popup"` next to `page`: "page / popup" dropdown; the simulator opens the page as a popup and the same key closes it. Other values = warning.
- RF11.2 `monitor`: `layout: "vertical"` (value under its name) and `marquee` (long value on one scrolling line) in editor and simulator.
- RF11.3 `nowPlayingEntity` on composed Activities, `track` tiles and tracked hotkeys (validated as an entity) and `dock.room` (room dropdown; unknown room = warning). The simulator's dock clock shows the player of the Activity active in that room (with no room: of the only active Activity; a composed Activity with a directly paired Apple TV uses it automatically), else `media_entities` with a playing player before a paused one, else any playing player.
- RF11.4 `select`: `layout: "dropdown"` (menu only, full width) and `font_size` (10–32, warning outside).
- RF11.5 `tv_remote`: volume row (− / mute / +) to `mute_entity`, else the TV, hidden with `show_volume: false`; app buttons on `media_entity`, default `media_player.<name of remote_entity>`; default apps Netflix, YouTube, Prime Video, Plex.
- RF11.6 Icons: `source_select.icon`, PNG icons on `switch` and `picture_elements` elements, `on_color` per element (colour palette).
- RF11.7 Simulator: a long press on MAIN opens Settings when no hotkey of the dashboard opens it and MAIN has no long-press hotkey.
- RF11.8 Pull and Push buttons also on every remote of the list and in the header of the open remote (all tabs), with the same flow as Sync (validation, verification, messages); from there a push over a drifted remote asks for confirmation.

### RF12 — Integration with the remote's version history (app 1.3.0)

Since 1.3.0 the remote keeps its own history of `dashboard.json` (`DashboardHistory.kt`): every save from the builder or its web page, and every `POST /dashboard.json`, is kept as a full copy with an optional note; content changed outside the web page is kept first (`outside`), a restore is a new version (`restore`); the last 30 versions plus pinned ones are kept. Routes: `GET /history`, `GET /history/<id>`, `POST /history/{restore,pin,note,delete}`; `POST /dashboard.json` accepts `note`.

The two histories compared:

| | Add-on | Remote 1.3.0 |
| --- | --- | --- |
| Retention | Everything, forever (in HA backups) | 30 + pinned |
| Storage | Differences between versions | Full copies |
| Labels | Unique names per remote | Free notes, pins |
| Scope | All remotes, copy between them | That remote only |
| Records edits made on the remote | Only when they're found as drift | Yes, every save |

Principle: the add-on's history (RF2) stays the master; the remote's history is a safety net and a record of what happened on the device, which the add-on reads and labels.

- RF12.1 Every push sends `note` = `ACM v<head>`, followed by `· "<name>"` when the head is a named version (max 200 characters). The add-on recognises its own versions in the remote's list by that prefix.
- RF12.2 Option per remote "Pin named versions on the remote" (off by default): after a push of a named version, the matching remote version (same note) is pinned so the remote never prunes it. A failed pin is logged and does not fail the push.
- RF12.3 When drift is detected, the newest entry of the remote's history explains it in the banner: restored from version X, changed outside the web page (e.g. Settings), saved from the builder with its note, or last saved by the add-on and then changed.
- RF12.4 History tab, "Remote history" panel (read-only): time, reason, note, pinned, pages/cards, and whether the version was pushed by the add-on (with its add-on version) or made on the remote. Actions: **Compare with head** (paths that differ), **Download**, **Import as version** (a new `sync-import` version carrying its origin; if it is the remote's current file the remote is in sync again, as after a pull).
- RF12.5 The add-on never restores, deletes or re-notes versions on the remote: to go back, import (or restore in the add-on) and push.
- RF12.6 No automatic mirroring of the remote's history into the add-on's history.
- RF12.7 Apps older than 1.3.0 (`/history` 404): the panel says it is not available, notes are ignored, nothing else changes.

### RF13 — Navigation map

- RF13.1 A "Navigation map" panel above the **Editor** (Modify / Simulate, RF18): hidden or shown with ▴/▾, height resizable by dragging the border between the map and the pane below (since 2.24; ↑/↓ when focused) (both remembered in the browser). Zoom with the wheel or a pinch, pan by dragging, buttons for zoom ± and "fit all"; it opens on "fit all".
- RF13.2 Every page is a **live mini preview** drawn by the simulator's own renderer (theme colours, current HA states refreshed at most every 3 s), display-only. Badges: ⭐ start page; 👁 shown only while its Activity runs (`hiddenUnlessActivity`), crossed out with `hideMode: full`.
- RF13.3 Layout follows the remote: upstream keeps **one continuous pager over the flat page list in file order** (hierarchy only changes the dots and Back), so all pages sit in one row in file order with 👋 between swipe neighbours. Back links to the parent are arcs under the row, every other link an arc above it. Special boxes in a row below: "Any page (global keys)", "Home Assistant", "Activities overlay", "Settings"; a link to a page name that does not exist points to a red ⚠ box.
- RF13.4 Connections, one per way to reach a page: 👋 swipe; ☝️ swipe up (`linkedPage`); 👆 tile/button tap (`page`); ✋ long press (`long_press.page`); 🎛 physical key with its name (page hotkeys from that page, global ones from "Any page"; `openOverlay`; `openCurrentActivityRoom` to the pages of that room's Activities; long Menu to Settings when no hotkey opens it); 🎬 Activity started → its page (scene `activity`, Activities overlay); 👇 swipe down → Activities overlay; 🏠 `openWhenEntity` (entity = state); ↩ child → parent with its key. Dashed line + ▣ = opens as a popup. A legend explains them.
- RF13.5 Clicks — Editor: page → page settings; card inside a preview → that card's form; connection → the element that creates it (tile, hotkey, Activity, page setting), opened and highlighted. The editor's selection is highlighted on the map. Simulator: page or connection → the simulated screen jumps there.
- RF13.6 Redrawn on every new version keeping the current zoom; no external library (works offline).
- RF13.7 Not drawable: pages opened by Home Assistant's page selector or by calls to the remote's web server (not in `dashboard.json`).
- RF13.8 Simulator fidelity fix found while mapping: horizontal swipe now runs over all pages in file order (skipping `hideMode: full` pages whose Activity is off); the dots still show only the current page's siblings.

### RF14 — Theme library

- RF14.1 Shared library of themes in the add-on data (in HA backups). A theme = name + the remote's `theme` block saved exactly as set (absent keys = remote default). Names unique, case-insensitive.
- RF14.2 Read-only presets (can be duplicated): **Default** (empty block = the remote's built-in theme), **Light**, **OLED black**, **High contrast**.
- RF14.3 Editor → Global → Theme toolbar: **Load** (picker with swatches and preview; replaces the `theme` block = one version, undoable), **Save as…** (overwriting a saved theme asks first; a preset is never overwritten), **Delete** (saved themes only).
- RF14.4 "Themes" tab on the main screen: list with swatches and preview; preview, rename, duplicate, delete, **Export** as `.json`, **Apply to remotes…** (one version per ticked remote, nothing pushed), **Import from file** (our export, a bare theme block or a whole dashboard.json; invalid colours and unknown keys reported and ignored; a name clash asks for a new name).
- RF14.5 Preview before applying: mini screen of the first page of the open remote (or of the remote chosen in the Themes tab) with the theme applied.

### RF15 — Editable navigation map

Editor tab only (the Simulator's map stays read-only). Every change is one version (undoable) and is validated as usual.

- RF15.1 Each screen has four anchors: left/right = swipe order, top = where links from tiles arrive, bottom = where hotkeys arrive. Valid targets light up while dragging. A short click keeps RF13.5; dragging on empty space pans.
- RF15.2 Swipe: dragging A's right anchor onto B's left anchor moves B right after A (A's left onto B's right: before A). Pages are referenced by name, so links stay valid; `startPage` follows its page. A swipe link cannot be removed (the remote always swipes through all pages): holding it explains this.
- RF15.3 Hardware key chips under the map in **one row, each key once**, with two anchors: ◧ left = "this page only" (the page selected in the editor, overrides the global binding) and ◨ right = "global"; bound hotkeys start from the anchor of their scope (orange edge = bound on the page, blue = global). Bindings that open no page (service, Harmony, IR, event, stop Activity) have no link: ⚡ on their scope's side, tooltip = the action. Dragging an anchor onto a screen's bottom anchor asks short/long press and page/popup, then writes `{key, page, pageMode}` in that page's (or the global) `hotkeys`/`longHotkeys`; an existing binding of that key there asks to be replaced.
- RF15.4 Dragging a `button_grid`/`scene_grid` tile of a preview (also inside `row` cards) onto a screen's top anchor asks tap/long tap and page/popup and writes `page`/`pageMode` on the tile or in its `long_press` block; an existing target asks to be replaced; a scene tile that starts an Activity warns that its tap shows the Activity's page.
- RF15.5 Press and hold (600 ms, mouse or touch) on a connection, then confirm: tap → removes `page`/`pageMode`; long tap → the same in `long_press` (dropped if empty); hotkey → the binding; swipe up → `linkedPage`/`linkedPageMode`; back → `parent`/`parentKey`; HA → `openWhenEntity`/`openWhenState`/`closeWhenState`/`openMode`. Activity and overlay links are read-only (edit them in the forms).
- RF15.6 Big **＋ New page** and **🗑 Delete page** buttons on the map bar (Editor, not in native-builder mode), same as the editor's: a new empty page with a unique name, selected right away; deleting the page selected in the editor asks first, saying how many links point to it (they then show as missing pages); `startPage` keeps its page; the last page can't be deleted. One version each, undoable.

### RF16 — Upstream 1.3.1–1.3.2-beta, map layout, the remote's builder

- RF16.1 Push reads `X-Astrion-Version-Id` (app 1.3.1+) to pin/label the remote version it created; on 1.3.0 the version is found by its note.
- RF16.2 Built-in weather (1.3.2-beta): Global section "Built-in weather" (`name`, `latitude`, `longitude`, `model` auto/meteofrance, `unit` celsius/fahrenheit) with **Find a town**, searched by the remote (`GET /weather-search`). Latitude/longitude are required and in range, otherwise the remote ignores the block (warning); unknown model/unit warned. `weather.astrion` counts as an existing entity when the block is usable and is offered in entity fields; the simulator shows it as "built-in, remote only".
- RF16.3 Map: screens dragged by their title bar, links following live; positions saved per remote in the add-on (by page name; in HA backups, never in `dashboard.json`), **Reset layout**; dragging never changes the swipe order. Switches **Page keys**, **Global keys** (show/hide that scope's anchor and links, never moved onto the "Any page" box; row hidden when both are off), **Links** (all) and one toggle per kind in the legend (kept in the browser). Key chips use the simulator's icons; keys with a binding stand out (tooltip = what they do), unbound ones are dimmed. With the global anchor shown, global hotkeys start only from their chips (the "Any page" box then stands for the swipe down only, so no key appears twice).
- RF16.4 Per-remote mode "Edit with the remote's builder" (remote option): the remote is the editor, the add-on the backup. While on: editor, map editing, undo/redo and theme loading are read-only, a banner offers **Edit in builder**, **Done**, **Turn mode off**. Before opening: unsynced add-on changes → **Push** / **Discard** (a `restore` version of the last synced one) / Cancel. Back in the tab (visible again, or Done): pull; changes are imported as a `sync-import` version carrying the note/reason of the remote's newest history entry; if the add-on also changed → the user keeps the remote's file (import) or the add-on's (push); never merged.
- RF16.5 **Open in builder ↗** / **History ↗** in the remote header: `http://<ip>:<port>/builder/` in a new tab (never an iframe: HA is HTTPS, the builder plain HTTP on the LAN), at the editor's selection with the 1.3.1-beta deep links (`#page=<name>`, `&card=<i>`, `#activity=<id>`, `#hotkeys`, `#history`). Greyed out with the reason when the remote is unreachable. Outside native mode, coming back re-checks drift.

### RF17 — Large preview pane, builder opened by a link

- RF17.1 Editor tab: a pane on the left shows the screen selected in the editor (tree or map) in large size, drawn by the simulator's renderer with live states, sticky while the forms scroll. Clicking a card opens its form (nothing is executed); the selected card is highlighted. Resizable by its right edge (220–520 px) and hideable; both remembered in the browser.
- RF17.2 "Open in builder ↗", "History ↗" and "Edit in builder ↗" are real links (`target="_blank"`, `rel="opener"`) followed on the user's click, never `window.open`: a script-opened tab is blocked as a pop-up inside Home Assistant's frame and in the companion app. In "Edit with the remote's builder" mode with unsynced changes the link first asks Push / Discard, then shows a dialog with the link to click.
- RF17.3 (2.22) The Editor (with its preview pane) collapses with a ▴/▾ chevron like the map, choice kept in the browser; a click on the map reopens it.

### RF18 — Editor and Simulator merged

Starting requirement: "merge the Simulator and Editor screens; add Simulate and Simulate & run that replace the lower pane with the simulation, including all the options of the tab".

- RF18.1 One **Editor** tab (the Simulator tab is removed). The "✎ Editor" bar under the map has the selector **✎ Modify** / **▶ Simulate** / **⚡ Simulate & run** and the ▴/▾ chevron (RF17.3); the chosen mode is kept in the browser.
- RF18.2 Modify = editor with the big preview (RF17). Simulate = simulator in navigation only (RF6.12: actions listed, not executed). Simulate & run = real execution (HA, Harmony, IR). One simulation session: switching between Simulate and Simulate & run keeps page, popups and states. The "Navigation only" switch is replaced by the selector; Docked, Reset device states, live state, hardware keys, device states, ◀ ▲ ▶ navigation stay.
- RF18.3 In the remote's-builder mode (RF16.4) the editor is read-only but simulation stays available.
- RF18.4 While simulating, a click on a screen of the map moves the simulator to that page and the map highlights the current page; the map is not editable. In Modify a click selects in the editor.

### RF19 — Upstream 1.3.3-beta, tile anchors

Starting requirement: "the new beta posts astrion-saved to window.opener after each save: adapt the add-on to use it. Move the navigation arcs of UI elements onto new anchors overlaid on the elements themselves".

- RF19.1 After each **Save to device** or history restore the builder (1.3.3-beta) posts `{type: "astrion-saved", versionId, reason: "save"|"restore"}` to the page that opened it. The add-on accepts it only from the open remote's builder origin (`http://<ip>:<port>`). In "Edit with the remote's builder" mode (RF16.4) it imports right away (same flow as **Done**: history note, conflicts asked, never merged; one import at a time); outside that mode it re-checks drift and shows the banner, never an automatic import. Tab return and **Done** stay as fallbacks (e.g. builder opened by hand).
- RF19.2 The rest of 1.3.3-beta is already covered: **IR command** action on hardware keys (`irDevice` + `irCommand`: editor, validation, simulator, ⚡ on the map); `versionId` from `POST /history/restore` is not used by the add-on; no new card field (schema regenerated).
- RF19.3 Map: tap, long-press and Activity links of tiles/buttons (`button_grid`, `scene_grid`, also inside `row`) start from a ● anchor overlaid on the tile in the preview (filled = linked), go up out of the screen and reach the target's top anchor; tile not visible in the preview → from the screen's bottom edge. When editing, anchors appear on every tile and drag like the tile (RF15.4); click = opens the tile in the editor. Anchors follow the screen when it is moved. The segment from the tile to the screen edge is drawn above the preview (2.26).

### RF20 — Hierarchy view of the map

Starting requirement: "suggest a graphical representation / position for parent pages and linked pages" → accepted proposal: hierarchy arrange button, group bands, numbered swipe chain, popup pages drawn smaller.

Constraint: upstream swipes through all pages in file order; `parent` only changes the dots and Back, `linkedPage` is the swipe up. The map only changes the drawing: `dashboard.json` is never touched.

- RF20.1 **⇅ Arrange by hierarchy** (edit and simulation): pages without a parent on the main row in file order; children one row under their parent (parent above its first child, columns in file order), grandchildren further down; a linked page (`linkedPage`) with no parent and no children goes above its first main-row source, slightly offset (if it is also a child the tree wins). Parent cycles are treated as roots. Positions saved in the per-remote map layout (RF16.3); ⟲ goes back to the single row, which stays the default.
- RF20.2 Links between screens on different rows: short vertical curve between the facing edges (↩ Back from the child's top to the parent's bottom; ☝️ from the source's top to the linked page).
- RF20.3 Sibling groups (= the remote's dot group): coloured strip under each child screen, one colour per parent, labelled with the parent's name; one joined band when the siblings sit side by side.
- RF20.4 Swipe order: ①②③ on each screen's title bar; two swipe neighbours not side by side on one row → thin dotted line; the side anchors reorder as before.
- RF20.5 A page reached ONLY as a popup (every link opening it — tile, key, linkedPage, openWhenEntity — is a popup; swipe doesn't count; never the start page) is drawn at its popup size (width × `popupWidth`, height × `popupHeight`, clamped 0.1–1, defaults 0.7/0.5). Only swipe-up popups → the source page's values (upstream Dashboard.kt), otherwise the page's own; content previewed, ▣ in the title; it stays in the swipe order.

## 6. Non-functional requirements

- RNF1 Add-on with an Ingress panel, accessible to HA administrators only.
- RNF2 Data persisted in the add-on's data volume, surviving restarts and updates, and included in HA backups.
- RNF3 Interface in Italian and English according to the HA user's language; English fallback.
- RNF4 Atomic version writes: a version is created entirely or not at all.
- RNF5 The add-on must reach the remotes and the Harmony Hubs over the local network.

## 7. Acceptance criteria

1. Register two remotes: each has version 1 and a separate history.
2. Edit a field and leave it: a version with only the delta is created; two undos create two `undo` versions and bring back the previous state; one redo restores; a new edit clears the redo.
3. Restore version 3 with the head at 8: the state matches version 3 and the head becomes 9; all versions 1–8 remain.
4. File with an unknown card: after edits and a push, the card is unchanged on the device.
5. File edited on the device with the online editor: when the panel opens the drift is shown and no automatic action is taken.
6. Non-existent HA entity in the head: push refused with a list of errors. Non-existent Harmony activity: push allowed.
7. Pressing a light icon in the simulator: the real light changes state and the card updates.
8. Pressing a Harmony action with a configured Hub IP: the command reaches the Hub; without an IP: action disabled with the reason.
9. Pressing an IR action with a configured emitter entity: the entity receives `send_command` with converted codes; without an entity: action disabled with the reason.
10. Removing a remote: it disappears from the list and appears in "Archived" with its whole history.
11. Assign the name "A" to version 3 with the head at 8, make further edits, restore "A": the state matches version 3 and a new `restore` version is created. Assigning the name created no version. A second name "a" on the same remote is refused.

## Implementation notes

Decisions taken during requirement consolidation, not part of the original text:

- Delivered as a Home Assistant app (add-on) repository, not HACS.
- UI in five languages (EN, IT, FR, ES, DE), extending RNF3.
- Reference schema: upstream release 1.2.0 (v2.7.0 of the add-on; previously 1.1.9-beta); 1.2.7-beta from v2.10.0 (RF10).
- Phased delivery: v1.0 covered RF1–RF5; v2.0 adds RF6 (simulator, Harmony, IR via Broadlink).
- RF6.3 fidelity: layout, colours (ThemeConfig) and controls follow the app; icons are simplified.
- Harmony routing: superseded by RF8 (v1.5), per-action `hub` with first-hub fallback.
- IR codes for the `local` target are converted to Broadlink `b64:` packets (fixed 38 kHz carrier); `extender` targets go to the extender (RF8.4).
