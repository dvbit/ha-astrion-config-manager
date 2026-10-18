/* Navigation map (spec RF13).
 *
 * - RF13.1  collapsible, resizable panel above the Editor and the Simulator;
 *           zoom (wheel / pinch), pan (drag), zoom ± and "fit all"; opens fitted.
 * - RF13.2  every page is a live mini preview drawn by the simulator's own
 *           renderer (theme, current HA states), display-only; ⭐ start page,
 *           👁 hiddenUnlessActivity (crossed with hideMode "full").
 * - RF13.3  layout: upstream Dashboard.kt keeps ONE continuous pager over the
 *           flat page list in file order, so all pages sit in one row, in
 *           file order, with 👋 between swipe neighbours. Child pages are tied
 *           to their parent by ↩ arcs drawn under the row; every other link is
 *           an arc above the row. Special boxes (any page / Home Assistant /
 *           Activities / Settings overlays) sit in a row below.
 * - RF13.4  one connection per way to reach a page (see MAP_KINDS); dashed =
 *           opens as a popup (▣).
 * - RF13.5  click: Editor -> page settings / card form / the element that
 *           creates a connection (via Editor.reveal); Simulator -> jump there.
 * - RF13.6  redrawn on every new version, keeping the current zoom.
 *
 * Navigation sent by Home Assistant's page selector or by calls to the
 * remote's web server is not in dashboard.json and cannot be drawn.
 */
"use strict";

/* Connection kinds: icon + CSS class (line style). Order = legend order. */
const MAP_KINDS = {
  swipe: { icon: "👋" },        // horizontal swipe (pager neighbours)
  swipe_up: { icon: "☝️" },     // page.linkedPage
  tap: { icon: "👆" },          // tile / button "page"
  long: { icon: "✋" },         // tile long_press "page"
  key: { icon: "🎛" },          // hotkey page / overlay / current Activity
  activity: { icon: "🎬" },     // Activity started -> its page
  ha: { icon: "🏠" },           // openWhenEntity (HA state)
  swipe_down: { icon: "👇" },   // swipe down -> Activities overlay
  back: { icon: "↩" },          // child -> parent (parentKey)
  broken: { icon: "⚠" },        // target page not found
};
const MAP_NODE_W = 220;          // preview width in map units
const MAP_GAP = 110;             // horizontal gap between pages
const MAP_SPECIAL = { w: 170, h: 64 };
const MAP_STORE = { open: "acm-map-open", height: "acm-map-h" };
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
  return e;
}
function mapStore(key, val) {
  try {
    if (val === undefined) return window.localStorage.getItem(key);
    window.localStorage.setItem(key, String(val));
  } catch (e) { /* storage unavailable: defaults are used */ }
  return null;
}

/* ---------- graph model (pure: dashboard.json -> nodes + edges) ---------- */

/* Builds {nodes, edges}. Every edge carries the JSON pointer of the element
 * that creates it (Editor.reveal target) or null for implicit links. */
function buildNavGraph(doc, hwLabel) {
  const pages = Array.isArray(doc && doc.pages) ? doc.pages : [];
  const byName = new Map(pages.map((p, i) => [String(p.name || "").toLowerCase(), i]));
  const acts = Array.isArray(doc && doc.activities) ? doc.activities.filter((a) => a && typeof a === "object") : [];
  const nodes = pages.map((p, i) => ({
    id: "p" + i, kind: "page", p: i, name: p.name || `#${i + 1}`,
    start: (Number.isInteger(doc.startPage) ? doc.startPage : 0) === i,
    hidden: p.hiddenUnlessActivity ? { activity: p.hiddenUnlessActivity, full: p.hideMode === "full" } : null,
  }));
  const edges = [];
  const missing = new Map();
  const target = (name) => {
    const idx = byName.get(String(name || "").toLowerCase());
    if (idx !== undefined) return "p" + idx;
    if (!missing.has(name)) missing.set(name, { id: "x" + missing.size, kind: "missing", name: String(name) });
    return missing.get(name).id;
  };
  const add = (from, toName, kind, opts) => {
    const to = target(toName);
    edges.push({ from, to, kind: to.startsWith("x") ? "broken" : kind, ...opts });
  };
  const popupOf = (mode) => String(mode || "").toLowerCase() === "popup";
  const keyName = (k, long) => `${hwLabel(String(k || "?").toUpperCase())}${long ? " ⏱" : ""}`;

  // 👋 swipe: neighbours in the flat pager (file order)
  for (let i = 0; i + 1 < pages.length; i++) edges.push({ from: "p" + i, to: "p" + (i + 1), kind: "swipe", path: null });

  pages.forEach((p, i) => {
    const from = "p" + i;
    const base = `/pages/${i}`;
    if (p.linkedPage) add(from, p.linkedPage, "swipe_up", { popup: popupOf(p.linkedPageMode), path: `${base}/linkedPage` });
    if (p.parent) add(from, p.parent, "back", { label: keyName(p.parentKey || "BACK"), path: `${base}/parent` });
    if (p.openWhenEntity) {
      add("ha", p.name, "ha", { popup: popupOf(p.openMode), label: `${p.openWhenEntity} = ${p.openWhenState || "on"}`, path: `${base}/openWhenEntity` });
    }
    walkCards(p.cards, `${base}/cards`, from);
    for (const [g, long] of [["hotkeys", false], ["longHotkeys", true]]) {
      (Array.isArray(p[g]) ? p[g] : []).forEach((hk, k) => hotkey(hk, from, long, `${base}/${g}/${k}`));
    }
  });
  for (const [g, long] of [["hotkeys", false], ["longHotkeys", true]]) {
    (Array.isArray(doc[g]) ? doc[g] : []).forEach((hk, k) => hotkey(hk, "any", long, `/${g}/${k}`));
  }
  // 1.2.9 settings fallback: long MAIN opens Settings when no hotkey does
  const allHk = [...(doc.hotkeys || []), ...(doc.longHotkeys || []), ...pages.flatMap((p) => [...(p.hotkeys || []), ...(p.longHotkeys || [])])];
  const longMain = [...(doc.longHotkeys || []), ...pages.flatMap((p) => p.longHotkeys || [])].some((h) => h && String(h.key).toUpperCase() === "MAIN");
  if (!allHk.some((h) => h && String(h.openOverlay || "").toLowerCase() === "settings") && !longMain) {
    edges.push({ from: "any", to: "ov_set", kind: "key", label: keyName("MAIN", true), path: null });
  }
  // 👇 swipe down from any page opens the Activities overlay; it lists the Activities
  if (acts.length) {
    edges.push({ from: "any", to: "ov_act", kind: "swipe_down", path: null });
    acts.forEach((a, k) => { if (a.page) add("ov_act", a.page, "activity", { label: a.name || a.id, path: `/activities/${k}` }); });
  }

  function walkCards(cards, basePath, from) {
    (Array.isArray(cards) ? cards : []).forEach((c, ci) => {
      const cp = `${basePath}/${ci}`;
      const o = (c && c.options) || {};
      if (c && c.type === "row") walkCards(o.cards, `${cp}/options/cards`, from);
      const listKey = { button_grid: "buttons", scene_grid: "scenes" }[c && c.type];
      if (!listKey) return;
      (Array.isArray(o[listKey]) ? o[listKey] : []).forEach((it, k) => {
        if (!it || typeof it !== "object") return;
        const ip = `${cp}/options/${listKey}/${k}`;
        const label = it.name || "";
        // SceneGridCard: "activity" wins over "page" (the Activity's own page is shown)
        const act = listKey === "scenes" && it.activity && acts.find((a) => a.id === it.activity);
        if (act && act.page) add(from, act.page, "activity", { label, path: ip });
        else if (it.page) add(from, it.page, "tap", { popup: popupOf(it.pageMode), label, path: ip });
        const lp = it.long_press;
        if (lp && typeof lp === "object") {
          const lact = lp.activity && acts.find((a) => a.id === lp.activity);
          if (lact && lact.page) add(from, lact.page, "activity", { label: `✋ ${label}`, path: `${ip}/long_press` });
          else if (lp.page) add(from, lp.page, "long", { popup: popupOf(lp.pageMode), label, path: `${ip}/long_press` });
        }
      });
    });
  }
  function hotkey(hk, from, long, path) {
    if (!hk || typeof hk !== "object") return;
    const label = keyName(hk.key, long);
    const ov = String(hk.openOverlay || "").toLowerCase();
    if (ov === "activities" || ov === "settings") edges.push({ from, to: ov === "activities" ? "ov_act" : "ov_set", kind: "key", label, path });
    else if (hk.openCurrentActivityRoom) {
      acts.filter((a) => a.room === hk.openCurrentActivityRoom && a.page).forEach((a) => add(from, a.page, "key", { label: `${label} ▶`, path }));
    } else if (hk.page) add(from, hk.page, "key", { popup: popupOf(hk.pageMode), label, path });
  }

  // special boxes only when something uses them
  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  const specials = [["any", "map_any_page", "🎛"], ["ov_act", "map_overlay_activities", "🎬"], ["ov_set", "map_overlay_settings", "⚙"], ["ha", "map_ha", "🏠"]]
    .filter(([id]) => used.has(id)).map(([id, label, icon]) => ({ id, kind: "special", label, icon }));
  return { nodes: [...nodes, ...specials, ...missing.values()], edges };
}

/* ---------- view ---------- */

class NavMap {
  /* opts: {rid, onSelect(target)}; target = {kind:"page"|"card"|"path", p, c, path} */
  constructor(opts) {
    Object.assign(this, opts);
    this.view = { x: 20, y: 20, k: 0.5 };
    this.fitted = false;
    this.mode = "editor";
    this.sel = null;
    this.open = mapStore(MAP_STORE.open) !== "0";
    this.height = parseInt(mapStore(MAP_STORE.height) || "360", 10) || 360;
    this.root = el("div", { class: "card navmap" });
    // Preview renderer = the simulator itself, without its own UI (RF13.2)
    this.preview = new Simulator({ rid: this.rid, remote: opts.remote, doc: opts.doc, preview: true });
    this.preview.schedule = () => this.schedulePreviews();
    this.preview.connect();
    api("GET", `api/remotes/${this.rid}/sim/active`).then((a) => { this.preview.active = a.active || {}; this.drawPreviews(); }).catch(() => {});
  }
  close() { this.preview.close(); }

  /* RF13.6: redraw on every new version; the view (zoom/pan) is kept. */
  setDoc(doc, remote, mode) {
    const changed = doc !== this.doc || remote !== this.remote || mode !== this.mode;
    this.doc = doc; this.remote = remote; this.mode = mode || "editor";
    this.preview.doc = doc; this.preview.remote = remote;
    if (changed || !this.root.firstChild) this.build();
  }

  hwLabel(k) {
    const name = t("key_" + k);
    return name && name !== "key_" + k ? name : k;
  }

  /* ---------- layout ---------- */
  layout(graph) {
    const r = this.remote || {};
    let w = r.width || 480, h = r.height || 800;
    if (((r.orientation || "portrait") === "portrait") !== (h >= w)) [w, h] = [h, w];
    const nh = Math.round(MAP_NODE_W * h / w) + 26; // + label strip
    this.screen = { w, h, nh };
    const pos = {};
    let x = 0;
    graph.nodes.filter((n) => n.kind === "page").forEach((n) => { pos[n.id] = { x, y: 0, w: MAP_NODE_W, h: nh }; x += MAP_NODE_W + MAP_GAP; });
    // under-row arcs (back links) need room before the special row
    const below = graph.edges.filter((e) => e.kind === "back").reduce((m, e) => Math.max(m, this.arcHeight(pos[e.from], pos[e.to])), 0);
    const rowY = nh + Math.max(140, below + 80);
    const extra = graph.nodes.filter((n) => n.kind !== "page");
    const span = Math.max(x - MAP_GAP, extra.length * (MAP_SPECIAL.w + 60));
    extra.forEach((n, i) => {
      pos[n.id] = { x: extra.length === 1 ? span / 2 - MAP_SPECIAL.w / 2 : (span - MAP_SPECIAL.w) * i / Math.max(1, extra.length - 1), y: rowY, w: MAP_SPECIAL.w, h: MAP_SPECIAL.h };
    });
    return pos;
  }
  arcHeight(a, b) { return a && b ? 50 + 0.28 * Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) : 0; }

  /* Route of one edge: quadratic curve + badge position. */
  route(e, pos, lane) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return null;
    const cx = (n) => n.x + n.w / 2;
    if (e.kind === "swipe") {
      const y = a.y + a.h / 2 + lane * 18;
      return { d: `M${a.x + a.w + 6},${y} L${b.x - 6},${y}`, bx: (a.x + a.w + b.x) / 2, by: y };
    }
    if (a.y === b.y && a.y === 0) {
      if (e.from === e.to) { // self loop (e.g. a popup hotkey on its own page)
        const x0 = a.x + a.w * 0.65, y0 = a.y;
        const d = `M${x0},${y0} C${x0 + 40},${y0 - 90 - lane * 20} ${x0 + 100},${y0 - 40} ${a.x + a.w},${y0 + 20}`;
        return { d, bx: x0 + 55, by: y0 - 60 - lane * 15 };
      }
      const under = e.kind === "back";
      const y0 = under ? a.y + a.h : a.y;
      const hgt = (this.arcHeight(a, b) + lane * 26) * (under ? 1 : -1);
      const sx = cx(a) + (cx(b) > cx(a) ? 20 : -20), ex = cx(b) + (cx(b) > cx(a) ? -20 : 20);
      const qx = (sx + ex) / 2, qy = y0 + hgt * 2;
      return { d: `M${sx},${y0} Q${qx},${qy} ${ex},${y0}`, bx: qx, by: y0 + hgt };
    }
    if (a.y === b.y) { // special <-> special: arc under the special row
      const y0 = a.y + a.h, sx = cx(a), ex = cx(b);
      const hgt = 40 + 0.15 * Math.abs(ex - sx) + lane * 20;
      return { d: `M${sx},${y0} Q${(sx + ex) / 2},${y0 + hgt * 2} ${ex},${y0}`, bx: (sx + ex) / 2, by: y0 + hgt };
    }
    // special row <-> page row
    const up = a.y > b.y;
    const sx = cx(a) + lane * 14, sy = up ? a.y : a.y + a.h;
    const ex = cx(b) + lane * 14, ey = up ? b.y + b.h : b.y;
    const my = (sy + ey) / 2;
    return { d: `M${sx},${sy} C${sx},${my} ${ex},${my} ${ex},${ey}`, bx: (sx + ex) / 2, by: my };
  }

  /* ---------- DOM ---------- */
  build() {
    const graph = buildNavGraph(this.doc || {}, (k) => this.hwLabel(k));
    this.graph = graph;
    const pos = this.layout(graph);
    this.pos = pos;
    const box = Object.values(pos).reduce((b, p) => ({
      x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x + p.w), y1: Math.max(b.y1, p.y + p.h),
    }), { x0: 0, y0: 0, x1: 0, y1: 0 });
    const maxArc = graph.edges.filter((e) => e.kind !== "back" && e.kind !== "swipe" && pos[e.from] && pos[e.to] && pos[e.from].y === 0 && pos[e.to].y === 0)
      .reduce((m, e) => Math.max(m, this.arcHeight(pos[e.from], pos[e.to]) + 60), 60);
    box.y0 -= maxArc + 30; box.x0 -= 60; box.x1 += 60; box.y1 += 140; // room for special <-> special arcs
    this.bounds = box;

    const world = el("div", { class: "navmap-world" });
    const svg = svgEl("svg", { class: "navmap-edges", width: box.x1 - box.x0, height: box.y1 - box.y0,
      viewBox: `${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}`, style: `left:${box.x0}px;top:${box.y0}px` });
    const defs = svgEl("defs");
    const marker = svgEl("marker", { id: "navmap-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    marker.append(svgEl("path", { d: "M0,0 L10,5 L0,10 z", class: "navmap-arrowhead" }));
    defs.append(marker);
    svg.append(defs);
    world.append(svg);
    this.edgeEls = [];
    const lanes = new Map();
    for (const e of graph.edges) {
      const key = [e.from, e.to].sort().join("|") + (e.kind === "back" ? "b" : "");
      const lane = lanes.get(key) || 0;
      lanes.set(key, lane + 1);
      const r = this.route(e, pos, lane);
      if (!r) continue;
      const path = svgEl("path", { d: r.d, class: `navmap-edge k-${e.kind}${e.popup ? " popup" : ""}`,
        "marker-end": "url(#navmap-arrow)", "marker-start": e.kind === "swipe" ? "url(#navmap-arrow)" : null });
      svg.append(path);
      const badge = el("button", { class: `navmap-badge k-${e.kind}${e.popup ? " popup" : ""}`, style: `left:${r.bx}px;top:${r.by}px`,
        title: this.edgeTitle(e) },
      el("span", { text: MAP_KINDS[e.kind].icon + (e.popup ? "▣" : "") }), e.label ? el("small", { text: e.label }) : null);
      badge.addEventListener("click", (ev) => { ev.stopPropagation(); if (!this.moved) this.pickEdge(e); });
      world.append(badge);
      this.edgeEls.push({ e, path, badge });
    }
    this.nodeEls = {};
    for (const n of graph.nodes) world.append(this.nodeEl(n, pos[n.id]));
    this.world = world;
    this.renderShell();
    this.drawPreviews();
    this.applyView();
    if (!this.fitted) requestAnimationFrame(() => { if (this.viewport && this.viewport.clientWidth) { this.fit(); this.fitted = true; } });
    if (this.sel) this.highlight(this.sel);
  }

  edgeTitle(e) {
    const how = t("map_k_" + e.kind) + (e.popup ? ` (${t("map_popup")})` : "");
    return `${how}${e.label ? ": " + e.label : ""}${e.path ? " — " + e.path : ""}`;
  }

  nodeEl(n, p) {
    const style = `left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px`;
    if (n.kind === "special") {
      const d = el("button", { class: "navmap-special", style }, el("span", { class: "navmap-sicon", text: n.icon }), el("span", { text: t(n.label) }));
      d.addEventListener("click", () => {
        if (this.moved) return;
        if (n.id === "any") this.onSelect({ kind: "path", path: "/hotkeys" });
        else if (n.id === "ov_act") this.onSelect({ kind: "path", path: "/activities" });
      });
      return d;
    }
    if (n.kind === "missing") {
      return el("div", { class: "navmap-special missing", style, title: t("map_missing") }, el("span", { class: "navmap-sicon", text: "⚠" }), el("span", { text: n.name }));
    }
    const badges = [n.start ? el("span", { title: t("map_start"), text: "⭐" }) : null,
      n.hidden ? el("span", { class: n.hidden.full ? "crossed" : "", title: `${t("map_hidden")} ${n.hidden.activity}${n.hidden.full ? " (hideMode: full)" : ""}`, text: "👁" }) : null];
    const label = el("div", { class: "navmap-label" }, el("span", { class: "navmap-idx", text: String(n.p + 1) }), el("strong", { text: n.name }), ...badges);
    const screen = el("div", { class: "navmap-screen" });
    const d = el("div", { class: "navmap-node", style, "data-p": n.p }, label, screen);
    d.addEventListener("click", (ev) => {
      if (this.moved) return;
      if (this.mode === "simulator") return this.onSelect({ kind: "page", p: n.p });
      const c = this.cardAt(screen, ev.clientX, ev.clientY);
      this.onSelect(c !== null ? { kind: "card", p: n.p, c } : { kind: "page", p: n.p });
    });
    this.nodeEls[n.p] = { d, screen };
    return d;
  }

  /* Card under a click: previews are display-only (pointer-events: none),
   * so the card is found by geometry among the page's direct children. */
  cardAt(screen, x, y) {
    const page = screen.querySelector(".sim-page");
    if (!page) return null;
    const kids = [...page.children];
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
    }
    return null;
  }

  /* RF13.2: live previews, rebuilt at most every few seconds on state changes. */
  schedulePreviews() {
    if (this.previewTimer) return;
    this.previewTimer = setTimeout(() => { this.previewTimer = null; this.drawPreviews(); }, 3000);
  }
  drawPreviews() {
    if (!this.nodeEls || !this.screen || !this.open) return;
    const sim = this.preview;
    const th = sim.theme();
    const { w, h } = this.screen;
    const scale = MAP_NODE_W / w;
    for (const [p, { screen }] of Object.entries(this.nodeEls)) {
      const page = (this.doc.pages || [])[p];
      if (!page) continue;
      const s = el("div", { class: "sim-screen", style: `width:${w}px;height:${h}px;transform:scale(${scale});background:${th.background};color:${th.primaryText};--card:${th.cardSurface};--inset:${th.insetSurface};--ctl:${th.controlBackground};--muted:${th.mutedText};--acc:${th.accent};--amber:${th.amber};--danger:${th.danger};--ok:${th.success}` });
      try { s.append(sim.renderPage(page, +p, false)); } catch (e) { s.append(el("p", { text: e.message })); }
      screen.replaceChildren(s);
    }
    if (this.sel) this.highlight(this.sel);
  }

  renderShell() {
    const toggle = el("button", { class: "icon", title: t("map_toggle"), text: this.open ? "▴" : "▾", onclick: () => {
      this.open = !this.open; mapStore(MAP_STORE.open, this.open ? "1" : "0"); this.renderShell(); if (this.open) this.drawPreviews();
    } });
    const head = el("div", { class: "row navmap-head" }, toggle, el("strong", { text: "🗺 " + t("map_title") }),
      el("span", { class: "muted", text: this.mode === "simulator" ? t("map_hint_sim") : t("map_hint_editor") }),
      el("span", { class: "spacer" }),
      this.open ? el("button", { class: "icon", title: t("map_zoom_out"), text: "−", onclick: () => this.zoomBy(1 / 1.25) }) : null,
      this.open ? el("button", { class: "icon", title: t("map_zoom_in"), text: "+", onclick: () => this.zoomBy(1.25) }) : null,
      this.open ? el("button", { class: "icon", title: t("map_fit"), text: "⤢ " + t("map_fit"), onclick: () => this.fit() }) : null,
      this.open ? el("button", { class: "icon", text: "? " + t("map_legend"), onclick: () => { this.legendOpen = !this.legendOpen; this.renderShell(); } }) : null);
    this.root.replaceChildren(head);
    if (!this.open) return;
    const vp = el("div", { class: "navmap-viewport", style: `height:${this.height}px` }, this.world);
    if (this.legendOpen) vp.append(this.legend());
    this.root.append(vp);
    this.viewport = vp;
    this.bindGestures(vp);
    // RF13.1: the height follows the drag handle (CSS resize) and is remembered
    if (this.ro) this.ro.disconnect();
    this.ro = new ResizeObserver(() => {
      const hgt = vp.clientHeight;
      if (hgt && hgt !== this.height) { this.height = hgt; mapStore(MAP_STORE.height, hgt); }
    });
    this.ro.observe(vp);
  }

  legend() {
    return el("div", { class: "navmap-legend" }, el("strong", { text: t("map_legend") }),
      ...Object.entries(MAP_KINDS).map(([k, v]) => el("div", { class: "row" }, el("span", { class: `navmap-badge static k-${k}`, text: v.icon }), el("span", { text: t("map_k_" + k) }))),
      el("div", { class: "row" }, el("span", { class: "navmap-badge static popup", text: "👆▣" }), el("span", { text: t("map_popup") })),
      el("div", { class: "row" }, el("span", { text: "⭐" }), el("span", { text: t("map_start") })),
      el("div", { class: "row" }, el("span", { text: "👁" }), el("span", { text: t("map_hidden") })),
      el("p", { class: "muted", text: t("map_limit") }));
  }

  /* ---------- pan / zoom (RF13.1) ---------- */
  applyView() {
    if (!this.world) return;
    this.world.style.transform = `translate(${this.view.x}px,${this.view.y}px) scale(${this.view.k})`;
    // connection badges stay readable when zoomed out (bounded counter-scale)
    this.world.style.setProperty("--bs", String(Math.min(2.5, Math.max(1, 0.55 / this.view.k))));
  }
  fit() {
    const vp = this.viewport; const b = this.bounds;
    if (!vp || !b) return;
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const k = Math.min(2, Math.max(0.05, Math.min(vp.clientWidth / bw, vp.clientHeight / bh) * 0.96));
    this.view = { k, x: (vp.clientWidth - bw * k) / 2 - b.x0 * k, y: (vp.clientHeight - bh * k) / 2 - b.y0 * k };
    this.applyView();
  }
  zoomBy(f, cx, cy) {
    const vp = this.viewport;
    if (!vp) return;
    if (cx === undefined) { cx = vp.clientWidth / 2; cy = vp.clientHeight / 2; }
    const k = Math.min(3, Math.max(0.05, this.view.k * f));
    this.view.x = cx - (cx - this.view.x) * (k / this.view.k);
    this.view.y = cy - (cy - this.view.y) * (k / this.view.k);
    this.view.k = k;
    this.applyView();
  }
  bindGestures(vp) {
    const pts = new Map();
    let last = null;
    vp.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    vp.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.moved = false;
      last = { x: e.clientX, y: e.clientY, dist: null, sx: e.clientX, sy: e.clientY };
    });
    vp.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId) || !last) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) { // pinch
        const [a, b] = [...pts.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const r = vp.getBoundingClientRect();
        if (last.dist) this.zoomBy(dist / last.dist, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        last.dist = dist; this.moved = true;
        return;
      }
      if (Math.hypot(e.clientX - last.sx, e.clientY - last.sy) > 4) {
        if (!this.moved) vp.setPointerCapture(e.pointerId);
        this.moved = true;
      }
      if (this.moved) {
        this.view.x += e.clientX - last.x; this.view.y += e.clientY - last.y;
        this.applyView();
      }
      last.x = e.clientX; last.y = e.clientY;
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (!pts.size) { last = null; setTimeout(() => { this.moved = false; }, 0); }
      else if (last) last.dist = null;
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
  }

  /* ---------- selection (RF13.5) ---------- */
  pickEdge(e) {
    if (this.mode === "simulator") {
      const to = this.graph.nodes.find((n) => n.id === e.to);
      if (to && to.kind === "page") this.onSelect({ kind: "page", p: to.p });
      return;
    }
    if (e.path) this.onSelect({ kind: "path", path: e.path });
    else {
      const to = this.graph.nodes.find((n) => n.id === e.to);
      if (to && to.kind === "page") this.onSelect({ kind: "page", p: to.p });
    }
  }

  /* Highlights the editor's selection (or the simulator's current page). */
  highlight(sel) {
    this.sel = sel;
    if (!this.nodeEls) return;
    for (const { d, screen } of Object.values(this.nodeEls)) {
      d.classList.remove("sel");
      screen.querySelectorAll(".navmap-card-sel").forEach((x) => x.classList.remove("navmap-card-sel"));
    }
    const ne = sel && sel.p !== undefined ? this.nodeEls[sel.p] : null;
    if (ne) {
      ne.d.classList.add("sel");
      if (sel.kind === "card") {
        const page = ne.screen.querySelector(".sim-page");
        const kid = page && page.children[sel.c];
        if (kid) kid.classList.add("navmap-card-sel");
      }
    }
    const path = sel && sel.path;
    for (const { e, path: pe, badge } of this.edgeEls || []) {
      const on = !!(path && e.path && (e.path === path || e.path.startsWith(path + "/") || path.startsWith(e.path + "/")));
      pe.classList.toggle("sel", on); badge.classList.toggle("sel", on);
    }
  }
}
