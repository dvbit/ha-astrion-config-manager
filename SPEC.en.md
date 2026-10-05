# Requirement — Astrion Config Manager (HA add-on) v1.4

> English translation of [SPEC.md](SPEC.md). The Italian document is the
> reference; in case of discrepancy the Italian text prevails.

Status: approved by the requester. v1.3: added RF6.12 (navigation-only mode). v1.4: added RF7 (icons and entity catalog). Supersedes v1.0: Harmony and IR are now in scope; named versions added (RF2.11–RF2.13). Original document language: Italian.

## 1. Purpose

Home Assistant add-on with an Ingress panel that manages the configurations (`dashboard.json`) of one or more Sanytron Astrion HA100 remotes running the *Astrion Custom Dashboard* app (repo `dckiller51/astrion-custom-dashboard`). It provides: a form editor, a delta version history with undo/redo, synchronisation with the remotes, and a simulator that reproduces the remote's behaviour and executes the real actions (Home Assistant, Harmony Hub, IR emitter).

## 2. Scope

**Included:** remote management, editor (including Harmony and IR), versions, validation, pull/push, detection of external changes, simulator. **Excluded:** the remote's connection settings towards HA and the Hub (they stay on the device); updating the remote's app; automatic discovery of remotes; permanent deletion of data.

## 3. References

- Reference schema: `dashboard.json` as defined by the most recent release of the repo at development time (last observed: 1.1.5-beta). Card and action behaviour: Kotlin sources (`cards/impl/`, `config/DashboardLoader.kt`) and web editor (`docs/index.html`, `cards.js`).
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

### RF3 — Editor

- RF3.1 Form editor for pages, cards and hotkeys, for all card types, fields and actions present in the reference schema (§3), including Harmony and IR cards and actions (IR devices and their codes included).
- RF3.2 Lossless round-trip: unknown cards, fields and actions remain intact in the saved file and can be edited as raw JSON. Key order is not guaranteed; the content is semantically identical.
- RF3.3 Copying pages and cards from one remote to another: creates a single version in the destination remote. Key/id collisions in the destination are resolved with a numeric suffix, updating the internal references to the copied elements.
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
- RF6.12 "Navigation only" switch: when on, actions (HA, Harmony, IR) are not executed, only listed; navigation, linked pages, popups and composed Activities (updated locally) are still simulated. The RF6.10 indicator shows the mode. Default: off.
- RF6.11 The simulator reproduces the behaviour the app has on the remote (conditional visibility of pages and cards, linked pages, overlays, popups, response to physical buttons), not just command sending. The editor is for designing the configuration; testing happens only in the simulator.

### RF7 — Icons and entity catalog

- RF7.1 Shared icon library in the add-on (PNG, JPEG, WebP, max 2 MB), included in HA backups. File names are normalised with the same rule as the remote.
- RF7.2 Deleting an icon removes it from the library only: the remote offers no deletion and keeps its copy.
- RF7.3 On push, icons used by the head and missing on the remote are uploaded from the library before the file. Icons present on a remote can be imported into the library.
- RF7.4 Every icon field of the editor has a thumbnail and a picker (library + remote icons); JSON editors can insert an icon path. The simulator shows the real icons. An icon missing from both the library and the remote is an error that blocks push.
- RF7.5 Form for the `haDevices` catalog (name, type, HA entity filtered by type). Catalog entries are offered in the editor's entity fields. A catalog entity that does not exist in HA blocks push.
- RF7.6 Copying pages/cards between remotes also copies the catalog entries of the entities they use.

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
- Reference schema at development time: upstream release 1.1.9-beta.
- Phased delivery: v1.0 covered RF1–RF5; v2.0 adds RF6 (simulator, Harmony, IR via Broadlink).
- RF6.3 fidelity: layout, colours (ThemeConfig) and controls follow the app; icons are simplified.
- Harmony actions are routed to the single Hub IP of RF1.1; the per-action `hub` field is ignored by the simulator.
- IR codes are converted to Broadlink `b64:` packets (fixed 38 kHz carrier); `extender` targets are routed through the same entity.
