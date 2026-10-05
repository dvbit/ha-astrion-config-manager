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

function iconFor(icon, entityId) {
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
    this.navOnly = false;         // RF6.12, remembered per browser
    try { this.navOnly = window.localStorage.getItem("acm-sim-nav-only") === "1"; } catch (e) { /* storage unavailable */ }
    this.connect();
    api("GET", `api/remotes/${this.rid}/sim/active`).then((a) => { this.active = a; this.render(); }).catch(() => {});
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

  /* Reason why a step cannot run (RF6.7/RF6.8), or null. */
  blocked(steps) {
    if (steps.some((s) => s.kind.startsWith("harmony")) && !this.remote.harmony_ip) return t("sim_no_harmony");
    if (steps.some((s) => s.kind === "ir") && !this.remote.ir_entity) return t("sim_no_ir");
    return null;
  }

  /* ---------- navigation (RF6.6, RF6.11) ---------- */
  goto(name, mode) {
    const idx = this.pageIndex(name);
    if (idx < 0) return toast(`${t("sim_page_missing")}: ${name}`, true);
    if (mode === "popup") this.popup = { page: idx }; else { this.cur = idx; this.popup = null; }
    this.render();
  }
  siblings() {
    const pages = this.pages(); const cur = pages[this.cur] || {};
    const act = this.activeIds();
    return pages.map((p, i) => [p, i]).filter(([p, i]) => (p.parent || null) === (cur.parent || null)
      && (i === this.cur || !p.hiddenUnlessActivity || act.has(p.hiddenUnlessActivity))).map(([, i]) => i);
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
      const opens = p.openWhenState ? s === p.openWhenState : this.isOn(p.openWhenEntity);
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
      for (const st of steps) {
        const act = st.kind === "activity" && (this.doc.activities || []).find((a) => a.id === st.id);
        if (act) this.active[act.room] = act.id;
        if (st.kind === "activity_stop") delete this.active[st.room];
      }
      if (steps.length) toast(t("sim_skipped", { list: steps.map((x) => this.describe(x)).join(" · ") }));
      if (nav) nav();
      return this.render();
    }
    const why = this.blocked(steps);
    if (why) return toast(why, true);
    if (steps.length) {
      try {
        const res = await api("POST", `api/remotes/${this.rid}/sim/action`, { steps });
        this.active = res.active;
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
      case "harmony_command": return `Harmony ${st.device}/${st.command}`;
      case "harmony_activity": return `Harmony activity ${st.activity}`;
      case "ir": return `IR ${st.device}/${st.command}`;
      case "activity": return `${t("activities")}: ${st.id}`;
      default: return st.kind;
    }
  }

  /* Upstream ButtonGridCard.fire / SceneGridCard tap -> steps. */
  stepsOf(o, scene) {
    const steps = [];
    if (scene && o.entity_id && !o.service) steps.push({ kind: "service", service: `${o.entity_id.split(".")[0]}.turn_on`, entity_id: o.entity_id });
    if (o.service) steps.push({ kind: "service", service: o.service, entity_id: o.entity_id || o.entityId, data: o.data });
    if (o.harmonyDevice && o.harmonyCommand) steps.push({ kind: "harmony_command", device: o.harmonyDevice, command: o.harmonyCommand });
    if (o.activityId) steps.push({ kind: "harmony_activity", activity: o.activityId });
    if (o.irDevice && o.irCommand) steps.push({ kind: "ir", device: o.irDevice, command: o.irCommand });
    if (scene && o.activity) steps.push({ kind: "activity", id: o.activity });
    return steps;
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
    if (!hk) {
      if (!long && page && page.parent && key === (page.parentKey || "BACK").toUpperCase()) return this.goto(page.parent);
      if (!long && key === "BACK" && this.popup) { this.popup = null; return this.render(); }
      return toast(`${key}: ${t("sim_no_hotkey")}`);
    }
    if (hk.openOverlay) { this.overlay = String(hk.openOverlay).toLowerCase(); return this.render(); }
    if (hk.openCurrentActivityRoom) {
      const act = (this.doc.activities || []).find((a) => a.id === this.active[hk.openCurrentActivityRoom]);
      return act && act.page ? this.goto(act.page) : toast(t("sim_no_activity"));
    }
    if (hk.page) return this.goto(hk.page);
    const steps = [];
    if (hk.harmonyActivity) steps.push({ kind: "harmony_activity", activity: hk.harmonyActivity });
    else if (hk.harmonyDevice && hk.harmonyCommand) steps.push({ kind: "harmony_command", device: hk.harmonyDevice, command: hk.harmonyCommand });
    else if (hk.irDevice && hk.irCommand) steps.push({ kind: "ir", device: hk.irDevice, command: hk.irCommand });
    else if (hk.service) steps.push({ kind: "service", service: hk.service, entity_id: hk.entityId, data: hk.data });
    this.run(steps);
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
    this.root.replaceChildren(
      el("div", { class: "card banner row sim-real" + (this.navOnly ? " nav-only" : "") },
        el("strong", { text: this.navOnly ? "🧭 " + t("sim_nav_banner") : "⚡ " + t("sim_real") }), el("span", { class: "spacer" }),
        el("label", { class: "row" }, sw, t("sim_nav_only")), liveBadge),
      el("div", { class: "sim-layout" }, el("div", { class: "sim-col" }, wrap,
        el("div", { class: "row sim-nav" },
          el("button", { text: "◀", onclick: () => this.swipe(-1) }), el("button", { text: "▲ " + t("sim_linked"), onclick: () => this.swipeUp() }),
          el("button", { text: "▶", onclick: () => this.swipe(1) }))), this.renderKeys()));
    const newPage = screen.querySelector(".sim-page:not(.in-popup)");
    if (newPage) newPage.scrollTop = this.scroll[this.cur] || 0;
    const newPop = screen.querySelector(".sim-popup");
    if (newPop && oldPop) newPop.scrollTop = popScroll;
  }

  dots() {
    const sib = this.siblings();
    return el("div", { class: "sim-dots" }, ...sib.map((i) => el("span", { class: i === this.cur ? "on" : "" })));
  }

  /* Swipes, as on the remote: horizontal = sibling pages, up = linkedPage.
   * Mouse drag and touch both arrive as pointer events. Vertical touch
   * scrolling stays native (CSS touch-action: pan-y); swipe-up only counts
   * when the page is already scrolled to the bottom, so scrolling a long
   * page never jumps to the linked page. Sliders are excluded. */
  gestures(screen) {
    let g = null;
    screen.addEventListener("pointerdown", (e) => {
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
      } else if (this.pending) { this.pending = false; this.render(); }
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
        body.append(this.tile(iconFor(a.icon), a.name || a.id, a.room, on,
          on ? [{ kind: "activity_stop", room: a.room }] : [{ kind: "activity", id: a.id }],
          () => { this.overlay = null; if (!on && a.page) this.goto(a.page); }));
      }
    } else body.append(el("p", { class: "sim-muted", text: t("sim_not_simulable") }));
    return el("div", { class: "sim-scrim" }, body);
  }

  /* Generic tile used by most cards. */
  tile(icon, label, sub, active, steps, nav, extra) {
    const why = steps ? this.blocked(steps) : null;
    const t0 = el("button", { class: "sim-tile" + (active ? " active" : "") + (why ? " blocked" : ""), title: why || null,
      onclick: () => (steps || nav) && this.run(steps || [], nav) },
    el("span", { class: "sim-ico", text: icon }), el("span", { class: "sim-lbl", text: label || "" }),
    sub != null && sub !== "" ? el("span", { class: "sim-sub", text: sub }) : null, why ? el("span", { class: "sim-why", text: "⛔ " + why }) : null);
    if (extra) t0.append(extra);
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
    return this.tile(iconFor(o.icon, id), this.name(o, id), this.isOn(id) ? t("sim_on") : t("sim_off"), this.isOn(id),
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
      o.media_controls === false ? null : el("div", { class: "row" }, this.ctl("⏮", s("media_previous_track")), this.ctl(this.state(id) === "playing" ? "⏸" : "▶", s("media_play_pause")), this.ctl("⏭", s("media_next_track"))),
      o.volume_controls === false ? null : el("div", { class: "row" }, this.ctl("🔉", s("volume_down")),
        o.show_volume_level !== false && vol != null ? el("span", { text: `${Math.round(vol * 100)}%` }) : null,
        this.ctl("🔊", s("volume_up")), this.ctl("🔇", s("volume_mute", { is_volume_muted: !this.attr(id, "is_volume_muted") }))));
  }
  card_select(o) {
    const id = o.entity_id; const opts = this.attr(id, "options") || [];
    return this.card(`${iconFor("select", id)} ${this.name(o, id)}`, el("div", { class: "row" },
      ...opts.map((op) => this.ctl(op, [{ kind: "service", service: `${String(id).split(".")[0]}.select_option`, entity_id: id, data: { option: op } }], this.state(id) === op))));
  }
  card_source_select(o) {
    const id = o.entity_id; const list = this.attr(id, "source_list") || []; const cur = this.attr(id, "source");
    return this.card(`${this.name(o, id)}`, el("div", { class: "row" },
      ...list.map((src) => this.ctl(src, [{ kind: "service", service: "media_player.select_source", entity_id: id, data: { source: src } }], cur === src))));
  }
  card_speaker_group(o) {
    const master = o.master; const members = this.attr(master, "group_members") || [];
    return this.card(`🔊 ${o.name || this.name({}, master)}`, ...(o.speakers || []).map((sp) => {
      const id = typeof sp === "string" ? sp : sp.entity_id || sp.entity;
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
      return this.tile(iconFor(b.icon, b.entity_id), b.name, null, act, this.stepsOf(b, false), this.navOf(b, false));
    }));
  }
  card_scene_grid(o) {
    const cols = o.columns || 3;
    return el("div", { class: "sim-grid", style: `grid-template-columns:repeat(${cols},1fr)` }, ...(o.scenes || []).map((sc) => {
      const act = (sc.activity && Object.values(this.active).includes(sc.activity))
        || (sc.state_entity && [].concat(sc.state_value || []).includes(this.state(sc.state_entity)));
      const tl = this.tile(iconFor(sc.icon, sc.entity_id), o.show_labels === false ? "" : sc.name, null, act, this.stepsOf(sc, true), this.navOf(sc, true));
      if (sc.color) tl.style.background = sc.color;
      return tl;
    }));
  }
  card_tv_remote(o) {
    const ent = o.remote_entity; const c = o.commands || {};
    const send = (k, d) => [{ kind: "service", service: "remote.send_command", entity_id: ent, data: { command: c[k] || d } }];
    const media = o.media_entity;
    return this.card(`📺 ${o.name || "TV"}`,
      el("div", { class: "row" }, this.ctl("⏻", send("power", "POWER")), el("span", { class: "spacer" }), this.ctl("🔇", [{ kind: "service", service: "remote.send_command", entity_id: o.mute_entity || ent, data: { command: c.mute || "MUTE" } }])),
      this.dpad((k) => send(k, { up: "DPAD_UP", down: "DPAD_DOWN", left: "DPAD_LEFT", right: "DPAD_RIGHT", center: "DPAD_CENTER" }[k])),
      el("div", { class: "row" }, this.ctl("↩", send("back", "BACK")), this.ctl("⌂", send("home", "HOME")), this.ctl("☰", send("menu", "MENU"))),
      el("div", { class: "row" }, ...(o.apps || []).map((a) => this.ctl(a.name || a.app || "app", a.service
        ? [{ kind: "service", service: a.service, entity_id: a.entity_id, data: a.data }]
        : [{ kind: "service", service: "media_player.play_media", entity_id: media, data: { media_content_type: "app", media_content_id: a.app } }]))));
  }
  card_apple_tv_remote(o) {
    const send = (cmd) => [{ kind: "harmony_command", device: o.deviceId, command: cmd }];
    return this.card(" Apple TV",
      this.dpad((k) => send({ up: "DirectionUp", down: "DirectionDown", left: "DirectionLeft", right: "DirectionRight", center: "Select" }[k])),
      el("div", { class: "row" }, this.ctl("☰ Menu", send("Menu")), this.ctl("Home", send("Home")), this.ctl("▶", send("Play")), this.ctl("⏸", send("Pause"))));
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
    return this.card(o.title || null, ...(o.entities || []).map((e) => {
      const id = typeof e === "string" ? e : e.entity || e.entity_id;
      const unit = this.attr(id, "unit_of_measurement");
      return el("div", { class: "row" }, el("span", { text: `${iconFor(typeof e === "object" ? e.icon : "", id)} ${this.name(typeof e === "object" ? e : {}, id)}` }),
        el("span", { class: "spacer" }), el("strong", { text: `${this.state(id) != null ? this.state(id) : "--"}${unit ? " " + unit : ""}` }));
    }));
  }
  card_camera(o) {
    const id = o.entity_id; const pic = this.attr(id, "entity_picture");
    return this.card(o.name || this.name({}, id), pic ? el("img", { class: "sim-art", src: `${pic}${pic.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 10000)}`, alt: "" })
      : el("div", { class: "sim-muted", text: `${id} — ${this.state(id) || "?"}` }));
  }
  card_picture_elements(o) {
    const box = el("div", { class: "sim-pic", style: o.aspect ? `aspect-ratio:${o.aspect}` : "" }, o.image ? el("img", { src: o.image, alt: "" }) : null);
    for (const e of o.elements || []) {
      const id = e.entity || e.entity_id;
      const style = Object.entries(e.style || {}).map(([k, v]) => `${k}:${v}`).join(";");
      const label = e.type === "state-label" ? `${this.state(id) || "--"}${this.attr(id, "unit_of_measurement") || ""}` : iconFor(e.icon, id);
      const steps = e.tap_action && e.tap_action.action === "toggle" ? [{ kind: "service", service: `${String(id).split(".")[0]}.toggle`, entity_id: id }]
        : this.stepsOf(e, false);
      box.append(el("button", { class: "sim-pe" + (this.isOn(id) ? " active" : ""), style: `position:absolute;${style}`, text: label,
        onclick: () => this.run(steps) }));
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
