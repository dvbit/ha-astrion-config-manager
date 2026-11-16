/* Shared helpers (3.0: moved here from the removed form editor and simulator). */
"use strict";

/* ---------- small DOM helpers ---------- */
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : String(kid));
  return e;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

/* HA100 hardware keys as laid out on the remote (upstream hotkeys.js HW_KEYS). */
const HW_LAYOUT = [
  ["POWER", "HOME", "MAIN"], ["VOLUME_UP", "UP", "PAGE_UP"], ["LEFT", "CENTER", "RIGHT"],
  ["VOLUME_DOWN", "DOWN", "PAGE_DOWN"], ["BACK", "MUTE", "VOICE"], ["REWIND", "PLAY", "STOP", "FASTFORWARD"],
  ["RED_BUTTON", "GREEN_BUTTON", "YELLOW_BUTTON", "BLUE_BUTTON"],
];
const HW_LABEL = { POWER: "⏻", HOME: "⌂", MAIN: "☰", VOLUME_UP: "🔊+", VOLUME_DOWN: "🔉−", UP: "▲", DOWN: "▼",
  LEFT: "◀", RIGHT: "▶", CENTER: "OK", PAGE_UP: "P+", PAGE_DOWN: "P−", BACK: "↩", MUTE: "🔇", VOICE: "🎤",
  REWIND: "⏪", PLAY: "⏯", STOP: "⏹", FASTFORWARD: "⏩", RED_BUTTON: "🔴", GREEN_BUTTON: "🟢",
  YELLOW_BUTTON: "🟡", BLUE_BUTTON: "🔵" };
/* Upstream hotkeys.js HW_KEY_ALIASES: other names the app accepts for a key. */
const HW_ALIASES = {
  MENU: "MAIN", FAST_FORWARD: "FASTFORWARD", MEDIA_FAST_FORWARD: "FASTFORWARD", MEDIA_REWIND: "REWIND",
  MEDIA_PLAY_PAUSE: "PLAY", PLAY_PAUSE: "PLAY", MEDIA_STOP: "STOP", VOLUME_MUTE: "MUTE",
  RED: "RED_BUTTON", GREEN: "GREEN_BUTTON", BLUE: "BLUE_BUTTON", YELLOW: "YELLOW_BUTTON",
  PROG_RED: "RED_BUTTON", PROG_GREEN: "GREEN_BUTTON", PROG_BLUE: "BLUE_BUTTON", PROG_YELLOW: "YELLOW_BUTTON",
};
const hwKey = (k) => { const u = String(k || "").toUpperCase(); return HW_ALIASES[u] || u; };
const LONG_PRESS_MS = 600;

/* Popup size fractions as DashboardLoader reads them (0.1..1, defaults 0.7 / 0.5). */
const popupFrac = (v, d) => (typeof v === "number" && isFinite(v) ? Math.min(1, Math.max(0.1, v)) : d);

/* Screen size of a remote in px (portrait / landscape as registered). */
function remoteSize(r) {
  let w = (r && r.width) || 480, h = (r && r.height) || 800;
  if ((((r && r.orientation) || "portrait") === "portrait") !== (h >= w)) [w, h] = [h, w];
  return { w, h };
}
