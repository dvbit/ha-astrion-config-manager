# Astrion Config Manager

Page map, page linking, full-screen navigation test and the embedded builder
for Astrion HA100 remotes running the
[astrion-custom-dashboard](https://github.com/dckiller51/astrion-custom-dashboard) app.

> **3.0**: single-screen editing is done in the remote's own builder (embedded in
> the **Builder** tab); the remote keeps the version history (app 1.3.0+).

## Requirements

- The remote's **config server** (port 8080) must be enabled in the app settings
  and reachable from Home Assistant. App 1.5.x recommended (1.5.8-beta followed).
- Home Assistant OS or Supervised (apps/add-ons).

## Options

| Option | Default | Description |
| --- | --- | --- |
| `log_level` | `info` | `trace`, `debug`, `info`, `warning`, `error` |

## Use

Open **Astrion** in the sidebar (admins only).

1. **Add remote**: name, IP, port, screen size and orientation (the remote must answer).
2. **🗺 Map**: every page drawn by the remote's builder with the ways to reach it.
   Drag a screen onto another to link them (tile/button, hardware key, swipe up,
   parent; page or popup). Press and hold a link's icon to cut it. Changes are written
   to the remote at once with a note; if the remote changed meanwhile nothing is written.
3. **▶ Simulate**: full-screen navigation test (tiles, long press, swipes, keys,
   popups). Nothing is sent to your devices.
4. **🛠 Builder**: the remote's builder; saving there refreshes the map. **🕘 History**
   opens the remote's history (undo).
5. **Themes** and **Icons**: shared libraries; a theme can be applied to several remotes.

Data lives in the app's `/data` volume and is included in Home Assistant backups.

Full documentation: see the repository README.
