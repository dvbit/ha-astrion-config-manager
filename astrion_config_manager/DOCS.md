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
   Changes made on the device are reported (drift) and never applied automatically.

5. **Simulator**: live preview of the head; taps and HA100 keys are executed
   for real (HA, Harmony Hub at the remote's Hub IP, IR via its `remote.*` entity).

6. **Icons**: shared library; missing icons are uploaded to a remote on push.

Data lives in the app's `/data` volume and is included in Home Assistant backups.
History is never deleted: remotes are archived, not removed.

Full documentation: see the repository README.
