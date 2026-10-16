# Astrion Config Manager

Versioned editor for the `dashboard.json` of Astrion HA100 remotes running the
[astrion-custom-dashboard](https://github.com/dckiller51/astrion-custom-dashboard) app.

## Requirements

- The remote's **config server** (port 8080) must be enabled in the app settings
  and reachable from Home Assistant.
- Home Assistant OS or Supervised (apps/add-ons).

## Options

| Option | Default | Description |
| --- | --- | --- |
| `log_level` | `info` | `trace`, `debug`, `info`, `warning`, `error` |

## Use

Open **Astrion** in the sidebar (admins only).

1. **Add remote**: name, IP, port, screen size and orientation. The first pull
   creates version 1; if the pull fails nothing is registered.
2. **Editor**: every committed change creates a version. Undo/redo are versions too.
3. **History**: restore any version, give names to milestones, filter named ones.
4. **Sync**: push sends the head after validation and verifies it by re-reading.
   Pull and Push are also on each remote of the list and in the open remote's header.
   Changes made on the device are reported (drift) and never applied automatically.

5. **Simulator**: live preview of the head; taps and HA100 keys are executed
   for real (HA, the remote's Harmony hubs, IR via its `remote.*` entity or extenders).

6. **Icons**: shared library; missing icons are uploaded to a remote on push;
   with app 1.2.7+ an icon can also be deleted on the remotes that no longer use it.

7. **App 1.2.7-beta**: dock screen and standby settings (Global), pages hidden
   during inactive Activities (`hideMode: full`), Off buttons (`stopActivity`),
   hotkey events (`astrion_button` on HA's bus), Apple TV layouts with apps. The
   simulator previews the dock screen (**Docked**) and remembers device states
   (**Reset device states** to clear them).

Data lives in the app's `/data` volume and is included in Home Assistant backups.
History is never deleted: remotes are archived, not removed.

Full documentation: see the repository README.
