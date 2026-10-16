/* Remote simulator (spec RF6).
 *
 * - RF6.1  always the head; re-rendered on every new version (setDoc).
 * - RF6.2  screen sized on width/height/orientation of the remote, scaled.
 * - RF6.3  every known card type rendered after the upstream Compose cards
 *          (cards/impl/*.kt, ThemeConfig colours). Fidelity is approximate:
 *          layout, colours and controls follow the app, icons are simplified.
 * - RF6.4  live HA state through the add-on websocket (api/.../sim/live).
 * - RF6.5/7/8 taps become "steps" executed for real by the backend.
 * - RF6.6/11 navigation, linked pages, popups, openWhenEntity,
 *          hiddenUnlessActivity and parent/back are simulated here.
 * - RF6.9  HA100 physical keys panel (short and long press).
 * - RF6.10 permanent "real execution" indicator.
 * - RF6.12 "navigation only" switch: actions are listed, not executed.
 * - RF9    direct Apple TV (1.2.0, appleTv / astrion_appletv.*) cannot be
 *          driven by the add-on: shown disabled with the reason.
 * - RF9.6  (1.2.1-beta) grid tiles' "long_press" block fires on hold.
 * - RF10   (1.2.2-1.2.7-beta) page hideMode "full" (skipped on swipes, left
 *          when its Activity stops), stopActivity / track / event steps,
 *          Apple TV layouts + apps, "Docked" preview of the dock screen,
 *          device-state memory (reset button).
 * - RF11   (1.2.8-1.2.9-beta) hotkey popups (toggle), MAIN long press opens
 *          Settings when no hotkey does, dock "Now playing" by room/Activity,
 *          monitor vertical/marquee, select dropdown, TV remote volume row.
 * - RF8    several Harmony hubs (action "hub" = localId, else first hub) and
 *          IR targets per device (local -> remote.* entity, or an extender).
 */
"use strict";

/* Upstream ThemeConfig defaults (config/AppConfig.kt). */
const THEME_DEFAULTS = {
  background: "#0E2229", cardSurface: "#1B343D", insetSurface: "#152B33", controlBackground: "#2C4C58",
  primaryText: "#E6F0F1", mutedText: "#93AFB6", iconTint: "#CBDCE0", accent: "#6EA8FE",
  accentSecondary: "#4C6EF5", amber: "#FFC24B", danger: "#E06767", success: "#4CAF50",
};
/* Simplified icons: by explicit mdi name keyword, then by entity domain. */
const ICONS = [
  [/light|lamp|bulb/, "💡"], [/tv|television/, "📺"], [/fan/, "🌀"], [/blind|curtain|shutter|cover|window/, "🪟"],
  [/thermo|climate|heat|snow|air/, "🌡️"], [/speaker|music|volume/, "🔊"], [/play/, "▶️"], [/power/, "⏻"],
  [/robot|vacuum/, "🤖"], [/camera|cctv/, "📷"], [/home|house/, "🏠"], [/movie|film|popcorn/, "🎬"],
  [/apple/, ""], [/game|xbox|playstation|controller/, "🎮"], [/sofa|couch/, "🛋️"], [/bed|sleep/, "🛏️"],
  [/door|lock/, "🔒"], [/plug|socket|switch|toggle/, "🔌"], [/star/, "⭐"], [/scene|palette/, "🎨"],
];
const DOMAIN_ICON = { light: "💡", switch: "🔌", fan: "🌀", cover: "🪟", climate: "🌡️", media_player: "🔊",
  vacuum: "🤖", camera: "📷", scene: "🎨", script: "📜", sensor: "📈", binary_sensor: "⚪", select: "☰",
  input_select: "☰", weather: "⛅", remote: "📡", lock: "🔒" };
const HW_LAYOUT = [
  ["POWER", "HOME", "MAIN"], ["VOLUME_UP", "UP", "PAGE_UP"], ["LEFT", "CENTER", "RIGHT"],
  ["VOLUME_DOWN", "DOWN", "PAGE_DOWN"], ["BACK", "MUTE", "VOICE"], ["REWIND", "PLAY", "STOP", "FASTFORWARD"],
  ["RED_BUTTON", "GREEN_BUTTON", "YELLOW_BUTTON", "BLUE_BUTTON"],
];
const HW_LABEL = { POWER: "⏻", HOME: "⌂", MAIN: "☰", VOLUME_UP: "🔊+", VOLUME_DOWN: "🔉−", UP: "▲", DOWN: "▼",
  LEFT: "◀", RIGHT: "▶", CENTER: "OK", PAGE_UP: "P+", PAGE_DOWN: "P−", BACK: "↩", MUTE: "🔇", VOICE: "🎤",
  REWIND: "⏪", PLAY: "⏯", STOP: "⏹", FASTFORWARD: "⏩", RED_BUTTON: "🔴", GREEN_BUTTON: "🟢",
  YELLOW_BUTTON: "🟡", BLUE_BUTTON: "🔵" };
const LONG_PRESS_MS = 600;

/* allowImg: custom icon paths (RF7) become "IMG:<name>", rendered by tile(). */
function iconFor(icon, entityId, allowImg) {
  const custom = iconName(icon);
  if (custom && allowImg) return "IMG:" + custom;
  const s = String(icon || "").toLowerCase();
  if (s && !s.startsWith("mdi:") && [...s].length <= 2) return icon; // emoji given as icon
  for (const [re, e] of ICONS) if (s && re.test(s)) return e;
  return DOMAIN_ICON[String(entityId || "").split(".")[0]] || "◻️";
}

class Simulator {
  /* opts: {root, rid, remote, doc} */
  constructor(opts) {
    Object.assign(this, opts);
    this.states = {};
    this.live = "connecting";     // connecting | ok | error
    this.active = {};             // room -> composed activity id (backend runtime)
    this.cur = 0;                 // current page index
    this.popup = null;            // {page: index, byEntity?: id}
    this.overlay = null;          // "activities" | "settings"
    this.autoOpened = new Set();  // openWhenEntity already fired
    this.pending = false;
    this.dragging = false;        // no re-render while a gesture is in progress
    this.scroll = {};             // page index -> scrollTop, kept across re-renders
    this.devStates = {};          // RF10.5 device-state memory (backend belief)
    this.docked = false;          // RF10.8 dock screen preview
    this.atvPlaying = {};         // AppleTvRemoteCard Harmony play/pause guess
    this.navOnly = false;         // RF6.12, remembered per browser
    try { this.navOnly = window.localStorage.getItem("acm-sim-nav-only") === "1"; } catch (e) { /* storage unavailable */ }
    this.connect();
    api("GET", `api/remotes/${this.rid}/sim/active`).then((a) => { this.setActive(a.active); this.devStates = a.devices || {}; this.render(); }).catch(() => {});
  }

  /* ---------- lifecycle ---------- */
  setDoc(doc, remote) {
    this.doc = doc; this.remote = remote;
    if (this.cur >= this.pages().length) this.cur = this.startPage();
    this.render();
  }
  close() { this.closed = true; if (this.ws) this.ws.close(); }

  /* RF6.4 live states. */
  connect() {
    const url = new URL(`api/remotes/${this.rid}/sim/live`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "states") { this.states = Object.fromEntries(m.states.map((s) => [s.entity_id, s])); this.live = "ok"; }
      else if (m.type === "state") { if (m.state) this.states[m.entity_id] = m.state; else delete this.states[m.entity_id]; this.live = "ok"; this.entityPages(); }
      else if (m.type === "error") this.live = "error";
      this.schedule();
    };
    this.ws.onclose = () => {
      if (this.closed) return;
      this.live = "error"; this.schedule();
      setTimeout(() => { if (!this.closed) this.connect(); }, 5000);
    };
  }
  schedule() {
    if (this.pending || this.dragging) { this.pending = true; return; }
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; if (!this.dragging) this.render(); });
  }

  /* ---------- helpers ---------- */
  pages() { return Array.isArray(this.doc && this.doc.pages) ? this.doc.pages : []; }
  startPage() { const s = this.doc && this.doc.startPage; return Number.isInteger(s) && s >= 0 && s < this.pages().length ? s : 0; }
  pageIndex(name) { return this.pages().findIndex((p) => String(p.name || "").toLowerCase() === String(name || "").toLowerCase()); }
  st(id) { return this.states[id]; }
  state(id) { const s = this.st(id); return s ? s.state : undefined; }
  attr(id, a) { const s = this.st(id); return s && s.attributes ? s.attributes[a] : undefined; }
  isOn(id) { return ["on", "open", "playing", "heat", "cool", "auto", "cleaning", "home"].includes(this.state(id)); }
  theme() { return { ...THEME_DEFAULTS, ...((this.doc && this.doc.theme) || {}) }; }
  activeIds() { return new Set(Object.values(this.active)); }

  /* RF8.2: hub chosen for a step (by localId, else the first; RF8.3 fallback IP). */
  hubFor(localId) {
    const hubs = (this.remote.harmony_hubs || []).filter((h) => h.ip);
    if (hubs.length) return hubs.find((h) => h.localId === localId) || hubs[0];
    return this.remote.harmony_ip ? { name: this.remote.harmony_ip, ip: this.remote.harmony_ip } : null;
  }
  /* RF8.4: IR target of a device: {kind:"local"} or {kind:"extender", ext}. */
  irTarget(deviceId) {
    const dev = (this.doc.irDevices || []).find((d) => d.id === deviceId);
    const ext = dev && dev.target && typeof dev.target === "object" ? dev.target.extender : null;
    if (!ext) return { kind: "local" };
    return { kind: "extender", id: ext, ext: (this.remote.extenders || []).find((x) => x.localId === ext) };
  }
  /* Reason why a step cannot run (RF6.7/RF6.8/RF8), or null. */
  blocked(steps) {
    // RF9.5: astrion_appletv.* and ANY call on a paired TV's entity run on the remote only
    const tvs = new Set((this.remote.apple_tvs || []).map((tv) => tv.entityId));
    if (steps.some((s) => s.kind === "service" && (String(s.service).startsWith("astrion_appletv.")
      || [].concat(s.entity_id || []).some((e) => tvs.has(e))))) return t("sim_appletv_direct");
    if (steps.some((s) => s.kind.startsWith("harmony")) && !this.hubFor(null)) return t("sim_no_harmony");
    for (const s of steps.filter((x) => x.kind === "ir")) {
      const tg = this.irTarget(s.device);
      if (tg.kind === "local" && !this.remote.ir_entity) return t("sim_no_ir");
      if (tg.kind === "extender" && !tg.ext) return `${t("sim_err_ir_extender_unknown")}: ${tg.id}`;
    }
    return null;
  }

  /* ---------- navigation (RF6.6, RF6.11) ---------- */
  goto(name, mode) {
    const idx = this.pageIndex(name);
    if (idx < 0) return toast(`${t("sim_page_missing")}: ${name}`, true);
    if (mode === "popup") this.popup = { page: idx }; else { this.cur = idx; this.popup = null; }
    this.render();
  }
  /* HiddenPages.isFullyHidden: hideMode "full" page whose Activity is not running. */
  fullyHidden(p, act) {
    return !!(p && p.hiddenUnlessActivity && p.hideMode === "full" && !(act || this.activeIds()).has(p.hiddenUnlessActivity));
  }
  /* Pages reachable by swiping. "dots" (default): the page stays in the pager,
   * only its dot is hidden; "full": skipped by swipes (RF10.2). */
  siblings() {
    const pages = this.pages(); const cur = pages[this.cur] || {};
    const act = this.activeIds();
    return pages.map((p, i) => [p, i]).filter(([p, i]) => (p.parent || null) === (cur.parent || null)
      && (i === this.cur || !this.fullyHidden(p, act))).map(([, i]) => i);
  }
  /* Dashboard.isDotVisible */
  dotPages() {
    const act = this.activeIds();
    return this.siblings().filter((i) => { const p = this.pages()[i]; return i === this.cur || !p.hiddenUnlessActivity || act.has(p.hiddenUnlessActivity); });
  }
  /* New runtime state; HiddenPageExitEffect: leave a "full" page whose
   * Activity just stopped (to its parent, else the nearest visible page). */
  setActive(active) {
    const before = this.activeIds();
    this.active = active || {};
    const after = this.activeIds();
    const pages = this.pages(); const p = pages[this.cur];
    if (!p || p.hideMode !== "full" || !p.hiddenUnlessActivity) return;
    if (!before.has(p.hiddenUnlessActivity) || after.has(p.hiddenUnlessActivity)) return;
    const par = p.parent ? this.pageIndex(p.parent) : -1;
    if (par >= 0 && !this.fullyHidden(pages[par], after)) { this.cur = par; return; }
    const near = (step) => { for (let i = this.cur + step; i >= 0 && i < pages.length; i += step) if (!this.fullyHidden(pages[i], after)) return i; return null; };
    const prev = near(-1); const next = near(1);
    this.cur = prev ?? next ?? 0;
  }
  swipe(dir) {
    const sib = this.siblings(); const pos = sib.indexOf(this.cur);
    const next = sib[pos + dir];
    if (next !== undefined) { this.cur = next; this.render(); }
  }
  swipeUp() {
    const p = this.pages()[this.cur];
    if (p && p.linkedPage) this.goto(p.linkedPage, p.linkedPageMode === "popup" ? "popup" : "page");
  }
  /* openWhenEntity / openWhenState / closeWhenState (DashboardEntityPageEffect). */
  entityPages() {
    this.pages().forEach((p, i) => {
      if (!p.openWhenEntity) return;
      const s = this.state(p.openWhenEntity);
      // DashboardLoader: openWhenState defaults to "on" (literal state match)
      const opens = s === (p.openWhenState || "on");
      const closes = p.closeWhenState ? s === p.closeWhenState : !opens;
      if (closes) {
        this.autoOpened.delete(p.openWhenEntity);
        if (this.popup && this.popup.byEntity === p.openWhenEntity) this.popup = null;
      } else if (opens && !this.autoOpened.has(p.openWhenEntity)) {
        this.autoOpened.add(p.openWhenEntity);
        if (p.openMode === "popup") this.popup = { page: i, byEntity: p.openWhenEntity }; else this.cur = i;
      }
    });
  }

  /* ---------- execution (RF6.5, RF6.7, RF6.8) ---------- */
  async run(steps, nav) {
    if (this.navOnly) {
      // RF6.12: nothing is sent to HA/Hub/IR; the composed Activity runtime is
      // updated locally so hiddenUnlessActivity pages still behave.
      const next = { ...this.active };
      for (const st of steps) {
        const act = st.kind === "activity" && (this.doc.activities || []).find((a) => a.id === st.id);
        if (act) next[act.room] = act.id;
        if (st.kind === "track") next[st.room] = st.id;
        if (st.kind === "activity_stop") {
          if (String(st.room).trim() === "*") Object.keys(next).forEach((r) => delete next[r]);
          else delete next[String(st.room).trim()];
        }
      }
      this.setActive(next);
      if (steps.length) toast(t("sim_skipped", { list: steps.map((x) => this.describe(x)).join(" · ") }));
      if (nav) nav();
      return this.render();
    }
    const why = this.blocked(steps);
    if (why) return toast(why, true);
    if (steps.length) {
      try {
        const res = await api("POST", `api/remotes/${this.rid}/sim/action`, { steps });
        this.setActive(res.active);
        if (res.devices) this.devStates = res.devices;
        const bad = res.results.filter((r) => !r.ok);
        if (bad.length) toast(bad.map((r) => `${t("sim_err_" + r.error)}${r.detail ? ` (${r.detail})` : ""}`).join(" · "), true);
      } catch (e) { await handleError(e); }
    }
    if (nav) nav();
    this.render();
  }

  /* Short human description of a step (navigation-only toast). */
  describe(st) {
    switch (st.kind) {
      case "service": return `${st.service}${st.entity_id ? " " + st.entity_id : ""}`;
      case "harmony_command": return `Harmony ${st.device}/${st.command} → ${(this.hubFor(st.hub) || {}).name || "?"}`;
      case "harmony_activity": return `Harmony activity ${st.activity} → ${(this.hubFor(st.hub) || {}).name || "?"}`;
      case "ir": {
        const tg = this.irTarget(st.device);
        return `IR ${st.device}/${st.command} → ${tg.kind === "local" ? (this.remote.ir_entity || t("local")) : ((tg.ext && tg.ext.name) || tg.id)}`;
      }
      case "activity": return `${t("activities")}: ${st.id}`;
      case "activity_stop": return `${t("sim_stop")}: ${st.room === "*" ? t("all_rooms") : st.room}`;
      case "track": return `${t("sim_track")}: ${st.room} → ${st.id}`;
      case "event": return `astrion_button: ${st.event} (${st.key}${st.long ? ", long" : ""})`;
      default: return st.kind;
    }
  }

  /* 1.2.1-beta GridLongPress.fireGridLongPress: steps of a "long_press" block.
   * entity_id alone -> <domain>.turn_on; hub falls back to the tile's own. */
  longPressOf(tile) {
    const lp = tile && tile.long_press;
    if (!lp || typeof lp !== "object" || Array.isArray(lp) || !Object.keys(lp).length) return null;
    const hub = lp.hub || tile.hub;
    const steps = [];
    if (lp.service && String(lp.service).includes(".")) steps.push({ kind: "service", service: lp.service, entity_id: lp.entity_id, data: lp.data });
    else if (lp.entity_id) steps.push({ kind: "service", service: `${String(lp.entity_id).split(".")[0]}.turn_on`, entity_id: lp.entity_id });
    if (lp.activityId) steps.push({ kind: "harmony_activity", activity: lp.activityId, hub });
    if (lp.harmonyDevice && lp.harmonyCommand) steps.push({ kind: "harmony_command", device: lp.harmonyDevice, command: lp.harmonyCommand, hub });
    if (lp.stopActivity) steps.push({ kind: "activity_stop", room: lp.stopActivity });
    if (lp.irDevice && lp.irCommand) steps.push({ kind: "ir", device: lp.irDevice, command: lp.irCommand });
    if (lp.activity) steps.push({ kind: "activity", id: lp.activity });
    return { steps, nav: this.navOf(lp, true) };
  }

  /* Upstream ButtonGridCard.fire / SceneGridCard tap -> steps. */
  stepsOf(o, scene) {
    const steps = [];
    const stop = o.stopActivity ? { kind: "activity_stop", room: o.stopActivity } : null;
    if (scene && o.entity_id && !o.service) steps.push({ kind: "service", service: `${o.entity_id.split(".")[0]}.turn_on`, entity_id: o.entity_id });
    if (o.service) steps.push({ kind: "service", service: o.service, entity_id: o.entity_id || o.entityId, data: o.data });
    if (scene && o.activityId) steps.push({ kind: "harmony_activity", activity: o.activityId, hub: o.hub });
    if (o.harmonyDevice && o.harmonyCommand) steps.push({ kind: "harmony_command", device: o.harmonyDevice, command: o.harmonyCommand, hub: o.hub });
    if (!scene && o.activityId) steps.push({ kind: "harmony_activity", activity: o.activityId, hub: o.hub });
    if (!scene && stop) steps.push(stop);
    if (o.irDevice && o.irCommand) steps.push({ kind: "ir", device: o.irDevice, command: o.irCommand });
    if (scene && stop) steps.push(stop);
    if (scene && o.activity) steps.push({ kind: "activity", id: o.activity });
    const tr = scene && this.trackOf(o);
    if (tr) steps.push(tr);
    return steps;
  }
  /* ActivityRuntime.activityFrom: a "track": true + "room" tile marks its room active. */
  trackOf(o) {
    if (o.track !== true || typeof o.room !== "string" || !o.room.trim()) return null;
    const name = o.name || o.entity_id || "Activity";
    const id = o.entity_id || o.activityId || String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return { kind: "track", room: o.room, id, harmony: o.activityId, hub: o.hub, devices: Array.isArray(o.devices) ? o.devices : [] };
  }
  navOf(o, scene) {
    return () => {
      if (scene && o.activity) {
        const act = (this.doc.activities || []).find((a) => a.id === o.activity);
        if (act && act.page) this.goto(act.page);
      } else if (scene && o.page) this.goto(o.page, o.pageMode === "popup" ? "popup" : "page");
      if (o.closePopup === true) this.popup = null;
    };
  }

  /* RF6.9: hotkeys (page overrides global, MainActivity.mergeHotkeys/runHotkey). */
  pressKey(key, long) {
    const page = this.popup ? this.pages()[this.popup.page] : this.pages()[this.cur];
    const g = long ? "longHotkeys" : "hotkeys";
    const merged = {};
    for (const hk of [...(this.doc[g] || []), ...((page && page[g]) || [])]) if (hk && hk.key) merged[hk.key.toUpperCase()] = hk;
    const hk = merged[key];
    // 1.2.9 MainActivity.bindSettingsFallback: long MAIN opens Settings when no hotkey anywhere does
    if (!hk && long && key === "MAIN" && !this.allHotkeys().some((h) => String(h.openOverlay || "").toLowerCase() === "settings")) {
      this.overlay = "settings"; return this.render();
    }
    if (!hk) {
      if (!long && page && page.parent && key === (page.parentKey || "BACK").toUpperCase()) return this.goto(page.parent);
      if (!long && key === "BACK" && this.popup) { this.popup = null; return this.render(); }
      return toast(`${key}: ${t("sim_no_hotkey")}`);
    }
    // MainActivity.runActivityHotkey: event, overlay, current Activity room, Off
    if (hk.event) {
      const pg = this.pages()[this.cur];
      return this.run([{ kind: "event", event: hk.event, key, long: !!long, page: (pg && pg.name) || "" }]);
    }
    if (hk.openOverlay) { this.overlay = String(hk.openOverlay).toLowerCase(); return this.render(); }
    if (hk.openCurrentActivityRoom) {
      const act = (this.doc.activities || []).find((a) => a.id === this.active[hk.openCurrentActivityRoom]);
      return act && act.page ? this.goto(act.page) : toast(t("sim_no_activity"));
    }
    if (hk.stopActivity) return this.run([{ kind: "activity_stop", room: hk.stopActivity }]);
    if (hk.page && String(hk.pageMode || "").toLowerCase() === "popup") {
      // 1.2.8: the page floats over the current one; the same key closes it again
      const idx = this.pageIndex(hk.page);
      if (this.popup && this.popup.page === idx) { this.popup = null; return this.render(); }
      return this.goto(hk.page, "popup");
    }
    if (hk.page) return this.goto(hk.page);
    const steps = [];
    if (hk.harmonyActivity) steps.push({ kind: "harmony_activity", activity: hk.harmonyActivity, hub: hk.hub });
    else if (hk.harmonyDevice && hk.harmonyCommand) steps.push({ kind: "harmony_command", device: hk.harmonyDevice, command: hk.harmonyCommand, hub: hk.hub });
    else if (hk.irDevice && hk.irCommand) steps.push({ kind: "ir", device: hk.irDevice, command: hk.irCommand });
    else if (hk.service) steps.push({ kind: "service", service: hk.service, entity_id: hk.entityId, data: hk.data });
    this.run(steps);
  }

  allHotkeys() {
    const d = this.doc || {};
    return [...(d.hotkeys || []), ...(d.longHotkeys || []), ...this.pages().flatMap((p) => [...(p.hotkeys || []), ...(p.longHotkeys || [])])]
      .filter((h) => h && typeof h === "object");
  }
  /* ActivityRuntime.nowPlayingEntity (1.2.8): player of the Activity active in
   * dock.room (case-insensitive) or, with no room, of the only active one. */
  activityPlayer(room) {
    const entries = Object.entries(this.active || {}).filter(([, id]) => id);
    const pick = room && String(room).trim()
      ? entries.find(([r]) => r.toLowerCase() === String(room).trim().toLowerCase())
      : (entries.length === 1 ? entries[0] : null);
    if (!pick) return null;
    const [r, id] = pick;
    const act = (this.doc.activities || []).find((a) => a && a.id === id);
    if (act) {
      // effectiveNowPlayingEntity: explicit, else a directly paired Apple TV among its devices
      return act.nowPlayingEntity || ((act.devices || []).find((d) => d && d.source === "ha" && String(d.deviceId).startsWith("media_player.appletv_")) || {}).deviceId || null;
    }
    for (const p of this.pages()) for (const c of p.cards || []) {
      if (c && c.type === "scene_grid") for (const sc of (c.options && c.options.scenes) || []) {
        const tr = sc && this.trackOf(sc);
        if (tr && tr.room === r && tr.id === id) return sc.nowPlayingEntity || null;
      }
    }
    for (const hk of this.allHotkeys()) {
      if (hk.track !== true || hk.room !== r) continue;
      const name = hk.harmonyActivity || hk.page || hk.key;
      if ((hk.entityId || hk.harmonyActivity || String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_")) === id) return hk.nowPlayingEntity || null;
    }
    return null;
  }

  /* ---------- rendering ---------- */
  render() {
    if (!this.root || !this.doc) return;
    const th = this.theme();
    const portrait = (this.remote.orientation || "portrait") === "portrait";
    let w = this.remote.width, h = this.remote.height;
    if (portrait !== (h >= w)) [w, h] = [h, w];
    const avail = Math.min(this.root.clientWidth || 380, 520);
    const scale = Math.min(1, avail / w);
    const screen = el("div", { class: "sim-screen", style: `width:${w}px;height:${h}px;transform:scale(${scale});background:${th.background};color:${th.primaryText};--card:${th.cardSurface};--inset:${th.insetSurface};--ctl:${th.controlBackground};--muted:${th.mutedText};--acc:${th.accent};--amber:${th.amber};--danger:${th.danger};--ok:${th.success}` });
    const wrap = el("div", { class: "sim-wrap", style: `width:${w * scale}px;height:${h * scale}px` }, screen);
    // Keep the scroll position of the current page/popup across re-renders
    // (live state updates rebuild the screen).
    const oldPage = this.root.querySelector(".sim-page:not(.in-popup)");
    if (oldPage && oldPage.dataset.idx !== undefined) this.scroll[oldPage.dataset.idx] = oldPage.scrollTop;
    const oldPop = this.root.querySelector(".sim-popup");
    const popScroll = oldPop ? oldPop.scrollTop : 0;
    const page = this.pages()[this.cur];
    if (page) screen.append(this.renderPage(page, this.cur, false));
    else screen.append(el("p", { text: "dashboard.json: no pages" }));
    screen.append(this.dots());
    if (this.popup) screen.append(this.renderPopup());
    if (this.overlay) screen.append(this.renderOverlay());
    if (this.docked) screen.append(this.renderDock());
    this.gestures(screen);
    const liveBadge = el("span", { class: `badge ${this.live === "ok" ? "in_sync" : this.live === "error" ? "unreachable" : ""}`,
      text: this.live === "ok" ? t("sim_live_ok") : this.live === "error" ? t("sim_live_err") : t("st_unknown") });
    const sw = el("input", { type: "checkbox" });
    sw.checked = this.navOnly;
    sw.onchange = () => {
      this.navOnly = sw.checked;
      try { window.localStorage.setItem("acm-sim-nav-only", this.navOnly ? "1" : "0"); } catch (e) { /* storage unavailable */ }
      this.render();
    };
    // RF10.8: preview of the dock screen (what the remote shows once idle on its dock)
    const dk = el("input", { type: "checkbox" });
    dk.checked = this.docked;
    dk.onchange = () => { this.docked = dk.checked; this.render(); };
    // RF10.5: forget the device states / active Activities the simulator believes in
    const reset = el("button", { text: t("sim_reset_states"), title: t("sim_reset_hint"), onclick: async () => {
      if (!confirm(t("sim_reset_hint"))) return;
      try { const r = await api("POST", `api/remotes/${this.rid}/sim/reset`); this.setActive(r.active); this.devStates = r.devices; this.render(); toast(t("sim_reset_done")); }
      catch (e) { await handleError(e); }
    } });
    this.root.replaceChildren(
      el("div", { class: "card banner row sim-real" + (this.navOnly ? " nav-only" : "") },
        el("strong", { text: this.navOnly ? "🧭 " + t("sim_nav_banner") : "⚡ " + t("sim_real") }), el("span", { class: "spacer" }),
        el("label", { class: "row" }, sw, t("sim_nav_only")), el("label", { class: "row" }, dk, t("sim_docked")), reset, liveBadge),
      el("div", { class: "sim-layout" }, el("div", { class: "sim-col" }, wrap,
        el("div", { class: "row sim-nav" },
          el("button", { text: "◀", onclick: () => this.swipe(-1) }), el("button", { text: "▲ " + t("sim_linked"), onclick: () => this.swipeUp() }),
          el("button", { text: "▶", onclick: () => this.swipe(1) })), this.renderDevStates()), this.renderKeys()));
    const newPage = screen.querySelector(".sim-page:not(.in-popup)");
    if (newPage) newPage.scrollTop = this.scroll[this.cur] || 0;
    const newPop = screen.querySelector(".sim-popup");
    if (newPop && oldPop) newPop.scrollTop = popScroll;
  }

  dots() {
    return el("div", { class: "sim-dots" }, ...this.dotPages().map((i) => el("span", { class: i === this.cur ? "on" : "" })));
  }

  /* Swipes, as on the remote: horizontal = sibling pages, up = linkedPage.
   * Mouse drag and touch both arrive as pointer events. Vertical touch
   * scrolling stays native (CSS touch-action: pan-y); swipe-up only counts
   * when the page is already scrolled to the bottom, so scrolling a long
   * page never jumps to the linked page. Sliders are excluded. */
  gestures(screen) {
    let g = null;
    screen.addEventListener("pointerdown", (e) => {
      this.suppressClick = false; // a new press: forget any swallowed click
      if (e.target.closest("input")) return;
      const pg = screen.querySelector(".sim-page:not(.in-popup)");
      const atBottom = !pg || pg.scrollTop + pg.clientHeight >= pg.scrollHeight - 2;
      g = { x: e.clientX, y: e.clientY, atBottom };
      this.dragging = true;
    });
    const end = (e, cancelled) => {
      if (!g) return;
      const dx = e.clientX - g.x, dy = e.clientY - g.y, start = g;
      g = null; this.dragging = false;
      let acted = false;
      if (!cancelled && !this.popup && !this.overlay) {
        if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) { acted = true; this.swipe(dx < 0 ? 1 : -1); }
        else if (dy < -80 && Math.abs(dy) > 1.5 * Math.abs(dx) && start.atBottom) { acted = true; this.swipeUp(); }
      }
      if (acted) {
        // swallow the click that may follow this pointerup, and only that one
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; }, 60);
      } else if (this.pending) {
        // Render the deferred live update only after the browser has delivered
        // the click of this tap: rendering now would replace the tile under the
        // pointer and the tap would be lost.
        setTimeout(() => { if (!this.dragging && this.pending) { this.pending = false; this.render(); } }, 0);
      }
    };
    screen.addEventListener("pointerup", (e) => end(e, false));
    screen.addEventListener("pointercancel", (e) => end(e, true)); // browser took over (native scroll)
    // A swipe that ends on a tile must not also "tap" it.
    screen.addEventListener("click", (e) => {
      if (this.suppressClick) { this.suppressClick = false; e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  renderPage(page, idx, inPopup) {
    const box = el("div", { class: "sim-page" + (inPopup ? " in-popup" : ""), "data-idx": idx });
    for (const card of page.cards || []) box.append(this.renderCard(card));
    return box;
  }

  renderPopup() {
    const p = this.pages()[this.popup.page] || {};
    const wf = Math.min(1, Math.max(0.1, p.popupWidth || 0.7)), hf = Math.min(1, Math.max(0.1, p.popupHeight || 0.7));
    const pos = p.popupPosition || "center";
    const box = el("div", { class: `sim-popup pos-${pos}`, style: `width:${wf * 100}%;height:${hf * 100}%` },
      el("div", { class: "row" }, el("strong", { text: p.name || "" }), el("span", { class: "spacer" }),
        el("button", { class: "icon", text: "✕", onclick: () => { this.popup = null; this.render(); } })),
      this.renderPage(p, this.popup.page, true));
    return el("div", { class: "sim-scrim", onclick: (e) => { if (e.target === e.currentTarget) { this.popup = null; this.render(); } } }, box);
  }

  renderOverlay() {
    const body = el("div", { class: "sim-popup pos-center", style: "width:80%;height:70%" },
      el("div", { class: "row" }, el("strong", { text: this.overlay === "activities" ? t("activities") : t("sim_settings") }),
        el("span", { class: "spacer" }), el("button", { class: "icon", text: "✕", onclick: () => { this.overlay = null; this.render(); } })));
    if (this.overlay === "activities") {
      for (const a of this.doc.activities || []) {
        const on = this.active[a.room] === a.id;
        body.append(this.tile(iconFor(a.icon, null, true), a.name || a.id, a.room, on,
          on ? [{ kind: "activity_stop", room: a.room }] : [{ kind: "activity", id: a.id }],
          () => { this.overlay = null; if (!on && a.page) this.goto(a.page); }));
      }
    } else body.append(el("p", { class: "sim-muted", text: t("sim_not_simulable") }));
    return el("div", { class: "sim-scrim" }, body);
  }

  /* Generic tile used by most cards. */
  tile(icon, label, sub, active, steps, nav, extra, long) {
    const why = steps ? this.blocked(steps) : null;
    const t0 = el("button", { class: "sim-tile" + (active ? " active" : "") + (why ? " blocked" : "") + (long ? " has-long" : ""),
      title: [why, long ? t("sim_long_hint") : null].filter(Boolean).join(" · ") || null,
      onclick: () => (steps || nav) && this.run(steps || [], nav) },
    icon && icon.startsWith && icon.startsWith("IMG:") ? iconImg(this.rid, icon.slice(4), "sim-ico-img") : el("span", { class: "sim-ico", text: icon }),
    el("span", { class: "sim-lbl", text: label || "" }),
    sub != null && sub !== "" ? el("span", { class: "sim-sub", text: sub }) : null, why ? el("span", { class: "sim-why", text: "⛔ " + why }) : null);
    if (extra) t0.append(extra);
    if (long) {
      // hold = long_press block; the click that follows the hold is swallowed
      let timer = null;
      t0.addEventListener("pointerdown", () => {
        timer = setTimeout(() => { timer = null; this.suppressClick = true; this.run(long.steps, long.nav); }, LONG_PRESS_MS);
      });
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      t0.addEventListener("pointerup", cancel);
      t0.addEventListener("pointerleave", cancel);
      t0.addEventListener("pointercancel", cancel);
    }
    return t0;
  }
  slider(value, min, max, onChange) {
    const s = el("input", { type: "range", min, max, value: value == null ? min : value, class: "sim-range" });
    s.onclick = (e) => e.stopPropagation();
    s.onchange = () => onChange(Number(s.value));
    return s;
  }
  ctl(label, steps, active) {
    const why = this.blocked(steps);
    return el("button", { class: "sim-ctl" + (active ? " active" : ""), title: why, disabled: !!why,
      text: label, onclick: () => this.run(steps) });
  }
  card(title, ...kids) {
    return el("div", { class: "sim-card" }, title ? el("div", { class: "sim-ctitle", text: title }) : null, ...kids);
  }
  name(o, id) { return o.name || this.attr(id, "friendly_name") || id || ""; }

  renderCard(card) {
    const o = (card && card.options) || {};
    const fn = this["card_" + (card && card.type)];
    if (!fn) return this.card(null, el("div", { class: "sim-unknown", text: `${(card && card.type) || "?"} — ${t("sim_not_simulable")}` }));
    try { return fn.call(this, o, card); } catch (e) {
      return this.card(null, el("div", { class: "sim-unknown", text: `${card.type}: ${e.message}` }));
    }
  }

  /* ---------- card renderers (upstream cards/impl) ---------- */
  card_title(o) {
    return el("div", { class: `sim-title align-${o.alignment || "start"}`, style: o.color ? `color:${o.color}` : "" },
      el("div", { class: "sim-h", text: `${o.icon ? iconFor(o.icon) + " " : ""}${o.title || ""}` }),
      o.subtitle ? el("div", { class: "sim-muted", text: o.subtitle }) : null, o.divider ? el("hr", {}) : null);
  }
  card_light(o) {
    const id = o.entity_id; const on = this.isOn(id);
    const bri = this.attr(id, "brightness");
    const pct = bri != null ? Math.round(bri / 2.55) : null;
    const explicit = ["show_brightness_control", "show_color_temp_control", "show_color_control"].some((k) => k in o);
    const t0 = this.tile(iconFor(o.icon, id), this.name(o, id), on ? (o.show_brightness !== false && pct != null ? `${pct}%` : t("sim_on")) : t("sim_off"),
      on, [{ kind: "service", service: "light.toggle", entity_id: id }]);
    if (o.show_brightness_control !== undefined ? o.show_brightness_control : !explicit) {
      t0.append(this.slider(pct || 0, 0, 100, (v) => this.run([v === 0 ? { kind: "service", service: "light.turn_off", entity_id: id }
        : { kind: "service", service: "light.turn_on", entity_id: id, data: { brightness_pct: v } }])));
    }
    return t0;
  }
  card_switch(o) {
    const id = o.entity_id;
    return this.tile(iconFor(o.icon, id, true), this.name(o, id), this.isOn(id) ? t("sim_on") : t("sim_off"), this.isOn(id),
      [{ kind: "service", service: `${String(id).split(".")[0]}.toggle`, entity_id: id }]);
  }
  card_fan(o) {
    const id = o.entity_id; const pct = this.attr(id, "percentage");
    const t0 = this.tile(iconFor("fan"), this.name(o, id), this.isOn(id) ? `${pct != null ? pct + "%" : t("sim_on")}` : t("sim_off"),
      this.isOn(id), [{ kind: "service", service: "fan.toggle", entity_id: id }]);
    t0.append(this.slider(pct || 0, 0, 100, (v) => this.run([{ kind: "service", service: "fan.set_percentage", entity_id: id, data: { percentage: v } }])));
    return t0;
  }
  card_cover(o) {
    const id = o.entity_id; const pos = this.attr(id, "current_position");
    const s = (svc) => [{ kind: "service", service: `cover.${svc}`, entity_id: id }];
    return this.card(`${iconFor("cover")} ${this.name(o, id)} · ${this.state(id) || "?"}${pos != null ? ` ${pos}%` : ""}`,
      o.show_buttons_control === false ? null : el("div", { class: "row" }, this.ctl("▲", s("open_cover")), this.ctl("■", s("stop_cover")), this.ctl("▼", s("close_cover"))),
      o.show_position_control === false ? null : this.slider(pos || 0, 0, 100, (v) => this.run([{ kind: "service", service: "cover.set_cover_position", entity_id: id, data: { position: v } }])));
  }
  card_climate(o) {
    const id = o.entity_id; const target = this.attr(id, "temperature"); const cur = this.attr(id, "current_temperature");
    const step = typeof o.step === "number" ? o.step : (this.attr(id, "target_temp_step") || 0.5);
    const set = (d) => [{ kind: "service", service: "climate.set_temperature", entity_id: id, data: { temperature: Math.round(((target || 20) + d) * 10) / 10 } }];
    const modes = this.attr(id, "hvac_modes") || [];
    return this.card(`${iconFor("climate")} ${this.name(o, id)}`,
      el("div", { class: "row sim-big" }, this.ctl("−", set(-step)), el("span", { text: `${target != null ? target : "--"}°` }), this.ctl("+", set(step))),
      el("div", { class: "sim-muted", text: `${t("sim_current")}: ${cur != null ? cur + "°" : "--"} · ${this.state(id) || "?"}` }),
      el("div", { class: "row" }, ...modes.map((m) => this.ctl(m, [{ kind: "service", service: "climate.set_hvac_mode", entity_id: id, data: { hvac_mode: m } }], this.state(id) === m))));
  }
  card_media_player(o) {
    const id = o.entity_id; const s = (svc, data) => [{ kind: "service", service: `media_player.${svc}`, entity_id: id, data }];
    const title = this.attr(id, "media_title"); const artist = this.attr(id, "media_artist");
    const pic = o.use_media_info !== false ? this.attr(id, "entity_picture") : null;
    const vol = this.attr(id, "volume_level");
    return this.card(`${iconFor(o.icon || "speaker", id)} ${this.name(o, id)} · ${this.state(id) || "?"}`,
      pic ? el("img", { class: "sim-art", src: pic, alt: "" }) : null,
      title ? el("div", { text: title }) : null, artist ? el("div", { class: "sim-muted", text: artist }) : null,
      // MediaPlayerCard: comma lists, absent = default, "" = none
      ...(() => {
        const list = (v, d) => (typeof v === "string" ? v : d).split(",").map((x) => x.trim()).filter(Boolean);
        const mc = list(o.media_controls, "previous,play_pause,next");
        const vc = list(o.volume_controls, "mute,buttons");
        const btn = { on_off: this.ctl("⏻", s("toggle")), shuffle: this.ctl("🔀", s("shuffle_set", { shuffle: !this.attr(id, "shuffle") })),
          previous: this.ctl("⏮", s("media_previous_track")), play_pause: this.ctl(this.state(id) === "playing" ? "⏸" : "▶", s("media_play_pause")),
          next: this.ctl("⏭", s("media_next_track")), repeat: this.ctl("🔁", s("repeat_set", { repeat: this.attr(id, "repeat") === "off" ? "all" : "off" })) };
        const rows = [];
        if (mc.length) rows.push(el("div", { class: "row" }, ...mc.filter((k) => btn[k]).map((k) => btn[k])));
        const vrow = [];
        if (vc.includes("mute")) vrow.push(this.ctl("🔇", s("volume_mute", { is_volume_muted: !this.attr(id, "is_volume_muted") })));
        if (vc.includes("buttons")) vrow.push(this.ctl("🔉", s("volume_down")), this.ctl("🔊", s("volume_up")));
        if (o.show_volume_level !== false && vol != null && vrow.length) vrow.push(el("span", { text: `${Math.round(vol * 100)}%` }));
        if (vrow.length) rows.push(el("div", { class: "row" }, ...vrow));
        if (vc.includes("set")) rows.push(this.slider(vol != null ? Math.round(vol * 100) : 0, 0, 100, (v) => this.run(s("volume_set", { volume_level: v / 100 }))));
        return rows;
      })());
  }
  card_select(o) {
    const id = o.entity_id; const opts = this.attr(id, "options") || [];
    const svc = `${String(id).split(".")[0]}.select_option`;
    if (o.layout === "dropdown") {
      // SelectCard 1.2.9 "dropdown": the menu alone, full width; font_size clamped 10-32 (default 16)
      const fs = typeof o.font_size === "number" ? Math.min(32, Math.max(10, o.font_size)) : 16;
      const s = el("select", { class: "sim-select", style: `font-size:${fs}px` },
        ...opts.map((op) => el("option", { value: op, text: op, selected: this.state(id) === op })));
      s.onclick = (e) => e.stopPropagation();
      s.onchange = () => this.run([{ kind: "service", service: svc, entity_id: id, data: { option: s.value } }]);
      return this.card(null, s);
    }
    return this.card(`${iconFor("select", id)} ${this.name(o, id)}`, el("div", { class: "row" },
      ...opts.map((op) => this.ctl(op, [{ kind: "service", service: `${String(id).split(".")[0]}.select_option`, entity_id: id, data: { option: op } }], this.state(id) === op))));
  }
  card_source_select(o) {
    const id = o.entity_id; const list = this.attr(id, "source_list") || []; const cur = this.attr(id, "source");
    const ic = o.icon ? iconFor(o.icon, id, true) : null;
    const head = ic && ic.startsWith("IMG:") ? el("div", { class: "row" }, iconImg(this.rid, ic.slice(4), "sim-ico-img"), el("strong", { text: this.name(o, id) }))
      : el("div", { class: "row" }, el("strong", { text: `${ic ? ic + " " : ""}${this.name(o, id)}` }));
    return this.card(null, head, el("div", { class: "row" },
      ...list.map((src) => this.ctl(src, [{ kind: "service", service: "media_player.select_source", entity_id: id, data: { source: src } }], cur === src))));
  }
  card_speaker_group(o) {
    const master = o.master; const members = this.attr(master, "group_members") || [];
    return this.card(`🔊 ${o.name || this.name({}, master)}`, ...(o.speakers || []).filter((sp) => sp && typeof sp === "object" && sp.entity_id).map((sp) => {
      const id = sp.entity_id;
      const joined = members.includes(id);
      return el("div", { class: "row" }, el("span", { text: this.name(typeof sp === "object" ? sp : {}, id) }), el("span", { class: "spacer" }),
        id === master ? el("span", { class: "sim-muted", text: "master" })
          : this.ctl(joined ? "−" : "+", joined ? [{ kind: "service", service: "media_player.unjoin", entity_id: id }]
            : [{ kind: "service", service: "media_player.join", entity_id: master, data: { group_members: [id] } }], joined));
    }));
  }
  card_button_grid(o) {
    const cols = o.columns || 3;
    return el("div", { class: "sim-grid", style: `grid-template-columns:repeat(${cols},1fr)` }, ...(o.buttons || []).map((b) => {
      const act = b.state_entity && [].concat(b.state_value || []).includes(this.state(b.state_entity));
      return this.tile(iconFor(b.icon, b.entity_id, true), b.name, null, act, this.stepsOf(b, false), this.navOf(b, false), null, this.longPressOf(b));
    }));
  }
  card_scene_grid(o) {
    const cols = o.columns || 3;
    return el("div", { class: "sim-grid", style: `grid-template-columns:repeat(${cols},1fr)` }, ...(o.scenes || []).map((sc) => {
      const tr = this.trackOf(sc);
      const act = (sc.activity && Object.values(this.active).includes(sc.activity)) || (tr && this.active[tr.room] === tr.id)
        || (sc.state_entity && [].concat(sc.state_value || []).includes(this.state(sc.state_entity)));
      const tl = this.tile(iconFor(sc.icon, sc.entity_id, true), o.show_labels === false ? "" : sc.name, null, act, this.stepsOf(sc, true), this.navOf(sc, true), null, this.longPressOf(sc));
      if (sc.color) tl.style.background = sc.color;
      return tl;
    }));
  }
  /* TvRemoteCard (1.2.9): commands renamable via "commands"; volume row (− / mute / +)
   * sent to mute_entity (else the TV), hidden by show_volume: false; apps on
   * media_entity, default media_player.<same name as remote_entity>. */
  card_tv_remote(o) {
    const ent = o.remote_entity;
    if (!ent) return this.card("📺 TV", el("div", { class: "sim-muted", text: t("sim_not_simulable") }));
    const c = o.commands || {};
    const mute = o.mute_entity || ent;
    const send = (k, d, target) => [{ kind: "service", service: "remote.send_command", entity_id: target || ent, data: { command: c[k] || d } }];
    const media = o.media_entity || `media_player.${String(ent).split(".").slice(1).join(".")}`;
    const DEFAULT_APPS = [{ name: "Netflix", app: "com.netflix.ninja" }, { name: "YouTube", app: "com.google.android.youtube.tv" },
      { name: "Prime Video", app: "com.amazon.amazonvideo.livingroom" }, { name: "Plex", app: "com.plexapp.android" }];
    const apps = Array.isArray(o.apps) ? o.apps : DEFAULT_APPS;
    return this.card(`📺 ${o.name || "TV"}`,
      el("div", { class: "row" }, this.ctl("⏻", send("power", "POWER"))),
      this.dpad((k) => send(k, { up: "DPAD_UP", down: "DPAD_DOWN", left: "DPAD_LEFT", right: "DPAD_RIGHT", center: "DPAD_CENTER" }[k])),
      el("div", { class: "row" }, this.ctl("↩", send("back", "BACK")), this.ctl("⌂", send("home", "HOME")), this.ctl("☰", send("menu", "MENU"))),
      o.show_volume === false ? null : el("div", { class: "row" }, this.ctl("🔉", send("volume_down", "VOLUME_DOWN", mute)),
        this.ctl("🔇", send("mute", "MUTE", mute)), this.ctl("🔊", send("volume_up", "VOLUME_UP", mute))),
      el("div", { class: "row" }, ...apps.filter((a) => a && typeof a === "object").map((a) => this.ctl(a.name || a.app || "app", a.service
        ? [{ kind: "service", service: a.service, entity_id: a.entity_id, data: a.data }]
        : [{ kind: "service", service: "media_player.play_media", entity_id: media, data: { media_content_type: "app", media_content_id: a.app } }]))));
  }
  /* AppleTvRemoteCard (1.2.0 + 1.2.7-beta layouts): appleTv (direct, wins) or
   * Harmony deviceId/hub. "layout" classic | compact | full; now-playing and
   * apps use "entity" (else the direct appleTv) via media_player.select_source;
   * "buttons" from ExtraButtons.CATALOG (default Menu, Home; compact adds ±10 s). */
  card_apple_tv_remote(o) {
    const direct = !!o.appleTv;
    if (!direct && !o.deviceId) return this.card(" Apple TV", el("div", { class: "sim-muted", text: t("sim_not_simulable") }));
    const send = (cmd) => direct
      ? [{ kind: "service", service: "astrion_appletv.send_command", entity_id: o.appleTv, data: { command: cmd } }]
      : [{ kind: "harmony_command", device: o.deviceId, command: cmd, hub: o.hub }];
    const media = o.entity || o.appleTv || null;
    const layout = ["compact", "full"].includes(o.layout) ? o.layout : "classic";
    const CAT = { Menu: "☰ Menu", Home: "⌂ Home", SeekBackward: "−10 s", SeekForward: "+10 s", Rewind: "⏪", FastForward: "⏩",
      Previous: "⏮", Next: "⏭", Siri: "🎤 Siri", Screensaver: "Screensaver", Guide: "Guide", VolumeUp: "Vol +", VolumeDown: "Vol −", ControlCenter: "Control Center" };
    const label = (id) => CAT[Object.keys(CAT).find((k) => k.toLowerCase() === String(id).toLowerCase())] || id;
    const buttons = (dflt) => (Array.isArray(o.buttons) && o.buttons.length ? o.buttons : dflt);
    const showArt = o.showArtwork !== false; const showProg = o.showProgress !== false;
    const showSkip = o.showSkip !== false && direct;
    const key = o.deviceId || o.appleTv;
    const playing = media && this.st(media) ? this.state(media) === "playing" : !!this.atvPlaying[key];
    // Harmony: separate Play/Pause codes, the card keeps its own guess
    const playPause = () => {
      const lbl = playing ? "⏸" : "▶";
      if (direct) return this.ctl(lbl, send("PlayPause"));
      const b = this.ctl(lbl, send(playing ? "Pause" : "Play"));
      b.addEventListener("click", () => { this.atvPlaying[key] = !playing; });
      return b;
    };
    const apps = media && Array.isArray(o.apps) ? o.apps.filter((a) => a && typeof a === "object" && a.source) : [];
    const appRow = (max, labels) => (apps.length ? el("div", { class: "row sim-atv-apps" }, ...apps.slice(0, max).map((a) => {
      const b = this.ctl(labels ? (a.label || a.source) : String(a.label || a.source).slice(0, 2).toUpperCase(),
        [{ kind: "service", service: "media_player.select_source", entity_id: media, data: { source: a.source } }], this.attr(media, "source") === a.source);
      if (a.color) b.style.background = a.color;
      b.title = a.label || a.source;
      return b;
    })) : null);
    const nowPlaying = (big) => {
      if (!media || !this.st(media)) return null;
      const pic = showArt ? this.attr(media, "entity_picture") : null;
      const dur = this.attr(media, "media_duration"); const pos = this.attr(media, "media_position");
      return el("div", { class: "sim-atv-np" + (big ? " big" : "") }, pic ? el("img", { class: "sim-art", src: pic, alt: "" }) : null,
        el("div", {}, el("strong", { text: this.attr(media, "media_title") || this.state(media) || "" }),
          el("div", { class: "sim-muted", text: this.attr(media, "app_name") || this.attr(media, "source") || "" }),
          showProg && dur ? el("progress", { max: dur, value: pos || 0 }) : null),
        big ? null : playPause());
    };
    const pad = this.dpad((k) => send({ up: "DirectionUp", down: "DirectionDown", left: "DirectionLeft", right: "DirectionRight", center: "Select" }[k]));
    const row = (ids) => el("div", { class: "row" }, ...ids.map((b) => this.ctl(label(b), send(b))));
    const kids = [];
    if (layout === "classic") {
      kids.push(pad, row(buttons(["Menu", "Home"])), el("div", { class: "row" }, playPause()), appRow(5, false));
    } else if (layout === "compact") {
      const strip = showArt || showProg ? nowPlaying(false) : null;
      kids.push(strip, pad, row(buttons(["Menu", "SeekBackward", "SeekForward", "Home"])), strip ? null : el("div", { class: "row" }, playPause()), appRow(6, false));
    } else {
      const btns = buttons(["Menu", "Home"]);
      const side = btns.slice(2, 8);
      kids.push(nowPlaying(true),
        el("div", { class: "row" }, btns[0] ? this.ctl(label(btns[0]), send(btns[0])) : null,
          showSkip ? this.ctl("−10 s", send("SeekBackward")) : null, playPause(),
          showSkip ? this.ctl("+10 s", send("SeekForward")) : null, btns[1] ? this.ctl(label(btns[1]), send(btns[1])) : null),
        appRow(5, true),
        side.length ? el("div", { class: "row sim-atv-sides" }, el("div", { class: "sim-col" }, ...side.filter((_, i) => i % 2 === 0).map((b) => this.ctl(label(b), send(b)))),
          pad, el("div", { class: "sim-col" }, ...side.filter((_, i) => i % 2 === 1).map((b) => this.ctl(label(b), send(b))))) : pad);
    }
    return this.card(` Apple TV${direct ? ` · ${this.name({}, o.appleTv)}` : ""} · ${layout}`, ...kids,
      direct ? el("div", { class: "sim-why", text: "⛔ " + t("sim_appletv_direct") }) : null);
  }
  dpad(stepsFor) {
    const b = (k, txt) => this.ctl(txt, stepsFor(k));
    return el("div", { class: "sim-dpad" }, el("span", {}), b("up", "▲"), el("span", {}), b("left", "◀"), b("center", "OK"), b("right", "▶"), el("span", {}), b("down", "▼"), el("span", {}));
  }
  card_vacuum(o) {
    const id = o.entity_id; const s = (svc) => [{ kind: "service", service: `vacuum.${svc}`, entity_id: id }];
    return this.card(`🤖 ${this.name(o, id)} · ${this.state(id) || "?"}`,
      o.map_image ? el("img", { class: "sim-art", src: o.map_image, alt: "", style: o.map_height ? `height:${o.map_height}px` : "" }) : null,
      el("div", { class: "row" }, this.ctl("▶", s("start")), this.ctl("⏸", s("pause")), this.ctl("⌂", s("return_to_base"))));
  }
  card_clock_weather(o) {
    const id = o.entity_id; const now = new Date();
    const time = now.toLocaleTimeString(LANG, { hour: "2-digit", minute: "2-digit", hour12: o.time_format === "12h" });
    return this.card(null, el("div", { class: "sim-big", text: time }),
      el("div", { class: "sim-muted", text: now.toLocaleDateString(LANG, { weekday: "long", day: "numeric", month: "long" }) }),
      id ? el("div", { text: `⛅ ${this.state(id) || "--"} · ${this.attr(id, "temperature") != null ? this.attr(id, "temperature") + "°" : ""}` }) : null);
  }
  card_monitor(o) {
    // MonitorCard: rows are {entity_id, name}; anything else is skipped, as on the remote
    return this.card(o.title || null, ...(o.entities || []).filter((e) => e && typeof e === "object" && e.entity_id).map((e) => {
      const id = e.entity_id;
      const unit = this.attr(id, "unit_of_measurement");
      const label = el("span", { text: `${iconFor(typeof e === "object" ? e.icon : "", id)} ${this.name(typeof e === "object" ? e : {}, id)}` });
      // 1.2.8: "vertical" puts the value under its name; "marquee" keeps it on one scrolling line
      const txt = `${this.state(id) != null ? this.state(id) : "--"}${unit ? " " + unit : ""}`;
      // scrolls only when it can't fit (approximation of the remote's measured overflow)
      const value = el("strong", { class: o.marquee === true && txt.length > 24 ? "sim-marquee" : "", text: txt });
      if (o.layout === "vertical") return el("div", { class: "sim-mon-v" }, label, value);
      return el("div", { class: "row" }, label, el("span", { class: "spacer" }), value);
    }));
  }
  card_camera(o) {
    const id = o.entity_id; const pic = this.attr(id, "entity_picture");
    return this.card(o.name || this.name({}, id), pic ? el("img", { class: "sim-art", src: `${pic}${pic.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 10000)}`, alt: "" })
      : el("div", { class: "sim-muted", text: `${id} — ${this.state(id) || "?"}` }));
  }
  /* PictureElementsCard: elements at left/top %, tap toggles entity_id, else
   * calls service (on "targets" when given); icon "power" = power glyph. */
  card_picture_elements(o) {
    const box = el("div", { class: "sim-pic", style: `aspect-ratio:${o.aspect || 1.3}` }, o.image ? el("img", { src: o.image, alt: "" }) : null);
    for (const e of o.elements || []) {
      const id = e.entity_id;
      // 1.2.9: "power", a PNG path (/sdcard/astrion/icons/x.png) or a bulb; on_color when on
      const png = typeof e.icon === "string" && e.icon.includes("/") ? iconName(e.icon) : null;
      const label = png ? "" : e.icon === "power" ? "⏻" : (this.isOn(id) ? "💡" : "○");
      let steps = [];
      if (id) steps = [{ kind: "service", service: `${String(id).split(".")[0]}.toggle`, entity_id: id }];
      else if (e.service) steps = [{ kind: "service", service: e.service, entity_id: (e.targets && e.targets.length) ? e.targets : undefined }];
      box.append(el("button", { class: "sim-pe" + (this.isOn(id) ? " active" : ""), title: id || e.service || "",
        style: `position:absolute;left:${e.left != null ? e.left : 50}%;top:${e.top != null ? e.top : 50}%${this.isOn(id) && e.on_color ? `;background:${e.on_color}` : ""}`, text: label,
        onclick: () => this.run(steps) }, png ? iconImg(this.rid, png, "sim-pe-img") : null));
    }
    return this.card(null, box);
  }
  card_plex(o) {
    const id = o.media_entity;
    return this.card(`🎞️ Plex${o.source ? " · " + o.source : ""}`, id ? el("div", { text: `${this.name({}, id)}: ${this.state(id) || "?"}` }) : null,
      el("div", { class: "sim-muted", text: t("sim_plex") }));
  }
  card_row(o) {
    return el("div", { class: "sim-row" }, ...(o.cards || []).map((c) => this.renderCard(c)));
  }

  /* RF10.5: what the simulator believes about each device (DeviceStateStore). */
  renderDevStates() {
    const names = Object.fromEntries([...(this.doc.irDevices || []), ...(this.doc.haDevices || [])]
      .filter((d) => d && (d.id || d.entityId)).map((d) => [d.id || d.entityId, d.name || d.id || d.entityId]));
    const rows = Object.entries(this.devStates || {}).filter(([, v]) => v && (v.on != null || v.input));
    if (!rows.length) return null;
    return el("div", { class: "card sim-devstates" }, el("strong", { text: t("sim_dev_states") }),
      ...rows.map(([id, v]) => el("div", { class: "row" }, el("span", { text: names[id] || id }), el("span", { class: "spacer" }),
        el("span", { class: "sim-muted", text: `${v.on === true ? t("sim_on") : v.on === false ? t("sim_off") : "?"}${v.input ? " · " + v.input : ""}` }))));
  }

  /* RF10.8 dock screen (ChargeDockMonitor / DockClockScreen, 1.2.7-beta):
   * charging = dashboard dimmed to near zero; dashboard = dashboard dimmed to
   * "brightness"; clock = black face with clock, date, weather, battery and
   * now playing. Night (sun.sun below the horizon, else 21:00-07:00) uses
   * night_brightness and, for the clock, dim amber. A tap leaves the preview. */
  renderDock() {
    const d = (this.doc && typeof this.doc.dock === "object" && this.doc.dock) || {};
    const mode = ["clock", "dashboard"].includes(d.mode) ? d.mode : "charging";
    const sun = this.state("sun.sun");
    const hour = new Date().getHours();
    const night = sun ? sun === "below_horizon" : hour >= 21 || hour < 7;
    const bri = night ? (typeof d.night_brightness === "number" ? d.night_brightness : 0.05) : (typeof d.brightness === "number" ? d.brightness : 0.2);
    const leave = () => { this.docked = false; this.render(); };
    if (mode !== "clock") {
      const level = mode === "charging" ? 0.02 : Math.min(1, Math.max(0.01, bri));
      return el("div", { class: "sim-dock-dim", style: `background:rgba(0,0,0,${1 - level})`, title: `${t("sim_docked")}: ${mode}`, onclick: leave },
        el("span", { class: "sim-dock-tag", text: `${t("sim_docked")} · ${mode} · ${Math.round(level * 100)}%` }));
    }
    const now = new Date();
    const h12 = d.time_format === 12 ? true : d.time_format === 24 ? false : undefined;
    const sym = { sunny: "☀", clear: "☀", "clear-night": "☾", partlycloudy: "⛅", cloudy: "☁", fog: "☁", rainy: "☂", pouring: "☂",
      "lightning-rainy": "☂", lightning: "⚡", snowy: "❄", "snowy-rainy": "❄", hail: "❄" };
    const w = d.weather_entity && this.st(d.weather_entity);
    const temp = w ? this.attr(d.weather_entity, "temperature") : null;
    const weather = w ? [sym[w.state], temp != null ? `${Math.round(temp)}°` : w.state].filter(Boolean).join(" ") : null;
    // DockClockScreen.nowPlayingEntity (1.2.8): Activity player, else media_entities
    // (playing before paused), else any playing media_player
    const list = Array.isArray(d.media_entities) ? d.media_entities : [];
    const firstActive = (ids) => { const t1 = ids.filter((id) => this.attr(id, "media_title")); return t1.find((id) => this.state(id) === "playing") || t1.find((id) => this.state(id) === "paused"); };
    const ap = this.activityPlayer(d.room);
    const np = ap ? firstActive([ap]) : list.length ? firstActive(list)
      : Object.keys(this.states).find((id) => id.startsWith("media_player.") && this.state(id) === "playing" && this.attr(id, "media_title"));
    const info = [weather, d.show_battery === false ? null : "🔋 --%"].filter(Boolean).join(" · ");
    // backlight level shown as the face's opacity (kept readable); the black background stays opaque
    const face = el("div", { class: "sim-dock-face", style: `opacity:${Math.max(0.35, Math.min(1, bri * 4))}` },
      el("div", { class: "sim-dock-time", text: now.toLocaleTimeString(LANG, { hour: "2-digit", minute: "2-digit", hour12: h12 }) }),
      el("div", { text: now.toLocaleDateString(LANG, { weekday: "long", day: "numeric", month: "long" }) }),
      info ? el("div", { class: "sim-muted", text: info }) : null,
      np ? el("div", { class: "sim-dock-np" }, el("strong", { text: this.attr(np, "media_title") }),
        el("div", { class: "sim-muted", text: [this.attr(np, "media_series_title"), this.attr(np, "media_artist")].filter(Boolean).join(" · ") })) : null);
    return el("div", { class: "sim-dock-clock" + (night ? " night" : ""), onclick: leave }, face,
      el("span", { class: "sim-dock-tag", text: `${t("sim_docked")} · clock · ${Math.round(bri * 100)}%` }));
  }

  /* RF6.9: physical keys of the HA100 (click = short, hold = long). */
  renderKeys() {
    const pad = el("div", { class: "card sim-keys" }, el("strong", { text: t("sim_keys") }), el("div", { class: "sim-muted", text: t("sim_keys_hint") }));
    for (const row of HW_LAYOUT) {
      pad.append(el("div", { class: "row" }, ...row.map((k) => {
        const b = el("button", { class: "sim-key", title: k, text: HW_LABEL[k] || k });
        let timer = null; let long = false;
        b.onpointerdown = () => { long = false; timer = setTimeout(() => { long = true; this.pressKey(k, true); }, LONG_PRESS_MS); };
        b.onpointerup = () => { clearTimeout(timer); if (!long) this.pressKey(k, false); };
        b.onpointerleave = () => clearTimeout(timer);
        return b;
      })));
    }
    return pad;
  }
}
