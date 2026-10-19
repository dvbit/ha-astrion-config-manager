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
 * - RF15    editable map (Editor tab only): side anchors = swipe order (drag
 *           A.right -> B.left moves B after A), top anchor = UI jumps (drag a
 *           grid tile onto it), bottom anchor = hotkeys (drag a key chip onto
 *           it); hardware key chips in two rows (keys of the selected page,
 *           global keys); press and hold a connection to remove it. Every
 *           change is one version (app commit), so it can be undone.
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
const MAP_CHIP = { w: 118, h: 46, gap: 14 };    // RF15.3 hardware key chips
const MAP_HOLD_MS = 600;                        // RF15.5 press-and-hold to remove
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
function buildNavGraph(doc, hwLabel, opts) {
  // RF15: global hotkeys start from their key chip ("kg:KEY"), those of the
  // selected page (opts.keysPage) from "kp:KEY"; other pages' from the page.
  const keysPage = opts && Number.isInteger(opts.keysPage) ? opts.keysPage : null;
  const chips = !!(opts && opts.chips);
  const chipsGlobal = chips && !(opts && opts.chipsGlobal === false);
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
  const add = (from, toName, kind, extra) => {
    const to = target(toName);
    // "orig" keeps the real kind of a broken link, so it can still be removed (RF15.5)
    edges.push({ from, to, kind: to.startsWith("x") ? "broken" : kind, orig: kind, ...extra });
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
      (Array.isArray(p[g]) ? p[g] : []).forEach((hk, k) => hotkey(hk, chips && i === keysPage ? "kp:" + String(hk && hk.key).toUpperCase() : from, long, `${base}/${g}/${k}`));
    }
  });
  for (const [g, long] of [["hotkeys", false], ["longHotkeys", true]]) {
    (Array.isArray(doc[g]) ? doc[g] : []).forEach((hk, k) => hotkey(hk, chipsGlobal ? "kg:" + String(hk && hk.key).toUpperCase() : "any", long, `/${g}/${k}`));
  }
  // 1.2.9 settings fallback: long MAIN opens Settings when no hotkey does
  const allHk = [...(doc.hotkeys || []), ...(doc.longHotkeys || []), ...pages.flatMap((p) => [...(p.hotkeys || []), ...(p.longHotkeys || [])])];
  const longMain = [...(doc.longHotkeys || []), ...pages.flatMap((p) => p.longHotkeys || [])].some((h) => h && String(h.key).toUpperCase() === "MAIN");
  if (!allHk.some((h) => h && String(h.openOverlay || "").toLowerCase() === "settings") && !longMain) {
    edges.push({ from: chipsGlobal ? "kg:MAIN" : "any", to: "ov_set", kind: "key", label: keyName("MAIN", true), path: null });
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
    if (ov === "activities" || ov === "settings") edges.push({ from, to: ov === "activities" ? "ov_act" : "ov_set", kind: "key", orig: "key", label, path });
    else if (hk.openCurrentActivityRoom) {
      acts.filter((a) => a.room === hk.openCurrentActivityRoom && a.page).forEach((a) => add(from, a.page, "key", { label: `${label} ▶`, path }));
    } else if (hk.page) add(from, hk.page, "key", { popup: popupOf(hk.pageMode), label, path });
  }

  // special boxes only when something uses them
  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  // with the global key row shown, global hotkeys start from their chips: the
  // "any page" box then only stands for the swipe down (no duplicated keys)
  const anyBox = chipsGlobal ? ["any", "map_any_swipe", "👇"] : ["any", "map_any_page", "🎛"];
  const specials = [anyBox, ["ov_act", "map_overlay_activities", "🎬"], ["ov_set", "map_overlay_settings", "⚙"], ["ha", "map_ha", "🏠"]]
    .filter(([id]) => used.has(id)).map(([id, label, icon]) => ({ id, kind: "special", label, icon }));
  return { nodes: [...nodes, ...specials, ...missing.values()], edges };
}

/* ---------- RF15 document changes (pure: doc in, new doc out) ---------- */

const mapPtr = (path) => path.split("/").slice(1).map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
function mapAt(doc, path) {
  let o = doc;
  for (const k of mapPtr(path)) { if (o == null) return undefined; o = o[Array.isArray(o) ? +k : k]; }
  return o;
}

/* RF15.2 swipe = file order: drop B next to A (after A for A.right -> B.left,
 * before A for A.left -> B.right). Pages are referenced by name, so links stay
 * valid; startPage follows the page it pointed to. */
function mapMovePage(doc, a, b, after) {
  const d = clone(doc);
  if (a === b || !d.pages[a] || !d.pages[b]) return d;
  const start = d.pages[Number.isInteger(d.startPage) ? d.startPage : 0];
  const anchor = d.pages[a];
  const [moved] = d.pages.splice(b, 1);
  const ia = d.pages.indexOf(anchor);
  d.pages.splice(after ? ia + 1 : ia, 0, moved);
  if (Number.isInteger(doc.startPage) && start) d.startPage = d.pages.indexOf(start);
  return d;
}

/* RF15.3 hotkey {key, page, pageMode}; scope = page index or null (global). */
function mapSetHotkey(doc, scope, key, long, page, popup) {
  const d = clone(doc);
  const owner = scope === null ? d : d.pages[scope];
  const g = long ? "longHotkeys" : "hotkeys";
  if (!Array.isArray(owner[g])) owner[g] = [];
  const hk = { key, page };
  if (popup) hk.pageMode = "popup";
  const idx = owner[g].findIndex((h) => h && String(h.key).toUpperCase() === key);
  if (idx >= 0) owner[g][idx] = hk; else owner[g].push(hk);
  return d;
}
function mapHotkeyOf(doc, scope, key, long) {
  const owner = scope === null ? doc : doc.pages[scope];
  const list = (owner && owner[long ? "longHotkeys" : "hotkeys"]) || [];
  return list.find((h) => h && String(h.key).toUpperCase() === key) || null;
}

/* RF15.4 tile tap / long tap -> page (or popup). */
function mapSetTileTarget(doc, tilePath, long, page, popup) {
  const d = clone(doc);
  const tile = mapAt(d, tilePath);
  const target = long ? (tile.long_press && typeof tile.long_press === "object" && !Array.isArray(tile.long_press) ? tile.long_press : (tile.long_press = {})) : tile;
  target.page = page;
  if (popup) target.pageMode = "popup"; else delete target.pageMode;
  return d;
}

/* RF15.5 removal; null = this connection cannot be removed from the map. */
function mapRemoveEdge(doc, e) {
  const kind = e.orig || e.kind;
  if (!e.path || !["tap", "long", "key", "swipe_up", "back", "ha"].includes(kind)) return null;
  const d = clone(doc);
  if (kind === "key") {
    const parts = e.path.split("/");
    const idx = +parts.pop();
    const list = mapAt(d, parts.join("/"));
    if (!Array.isArray(list)) return null;
    list.splice(idx, 1);
    return d;
  }
  const objPath = ["swipe_up", "back", "ha"].includes(kind) ? e.path.split("/").slice(0, -1).join("/") : e.path;
  const o = mapAt(d, objPath);
  if (!o || typeof o !== "object") return null;
  const drop = { tap: ["page", "pageMode"], long: ["page", "pageMode"], swipe_up: ["linkedPage", "linkedPageMode"],
    back: ["parent", "parentKey"], ha: ["openWhenEntity", "openWhenState", "closeWhenState", "openMode"] }[kind];
  for (const k of drop) delete o[k];
  if (kind === "long" && !Object.keys(o).length) delete mapAt(d, e.path.split("/").slice(0, -1).join("/")).long_press;
  return d;
}

/* RF15.6 add a page like the editor's "+ Add page" (empty, name made unique). */
function mapAddPage(doc, base) {
  const d = clone(doc);
  if (!Array.isArray(d.pages)) d.pages = [];
  const used = new Set(d.pages.map((p) => String(p && p.name || "").toLowerCase()));
  let n = d.pages.length + 1;
  while (used.has(`${base} ${n}`.toLowerCase())) n++;
  d.pages.push({ name: `${base} ${n}`, cards: [] });
  return d;
}
/* RF15.6 delete a page like the editor's ✕ (links pointing to it stay and are
 * reported as missing pages); startPage keeps pointing to the same page. */
function mapDeletePage(doc, p) {
  const d = clone(doc);
  if (!d.pages || !d.pages[p] || d.pages.length < 2) return null;
  const start = Number.isInteger(d.startPage) ? d.startPage : null;
  d.pages.splice(p, 1);
  if (start !== null) d.startPage = start === p ? 0 : start > p ? start - 1 : start;
  return d;
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
    const saved = (this.remote && this.remote.map_layout) || {};
    graph.nodes.filter((n) => n.kind === "page").forEach((n) => {
      const sp = saved[n.name]; // RF16.3: dragged positions, by page name
      pos[n.id] = sp ? { x: sp.x, y: sp.y, w: MAP_NODE_W, h: nh } : { x, y: 0, w: MAP_NODE_W, h: nh };
      x += MAP_NODE_W + MAP_GAP;
    });
    const pagePos = graph.nodes.filter((n) => n.kind === "page").map((n) => pos[n.id]);
    const bottom = pagePos.reduce((m, p) => Math.max(m, p.y + p.h), nh);
    const left = pagePos.reduce((m, p) => Math.min(m, p.x), 0);
    // under-row arcs (back links) need room before the special row
    const below = graph.edges.filter((e) => e.kind === "back").reduce((m, e) => Math.max(m, this.arcHeight(pos[e.from], pos[e.to])), 0);
    const rowY = bottom + Math.max(140, below + 80);
    const extra = graph.nodes.filter((n) => n.kind !== "page");
    const specials = extra.filter((n) => n.kind === "special" || n.kind === "missing");
    const span = Math.max(x - MAP_GAP, specials.length * (MAP_SPECIAL.w + 60));
    specials.forEach((n, i) => {
      pos[n.id] = { x: left + (specials.length === 1 ? span / 2 - MAP_SPECIAL.w / 2 : (span - MAP_SPECIAL.w) * i / Math.max(1, specials.length - 1)), y: rowY, w: MAP_SPECIAL.w, h: MAP_SPECIAL.h };
    });
    // RF15.3 key rows under the special row (special<->special arcs need ~140)
    // chips wrap into a grid no wider than the page row (keeps "fit all" usable)
    const cols = Math.max(6, Math.min(12, Math.floor((span + MAP_CHIP.gap) / (MAP_CHIP.w + MAP_CHIP.gap))));
    let ky = rowY + MAP_SPECIAL.h + 170;
    for (const scope of ["p", "g"]) {
      pos["row:" + scope] = { x: left, y: ky - 34, w: 600, h: 26 };
      const chips = extra.filter((c) => c.kind === "keychip" && c.scope === scope);
      chips.forEach((n, i) => {
        pos[n.id] = { x: left + (i % cols) * (MAP_CHIP.w + MAP_CHIP.gap), y: ky + Math.floor(i / cols) * (MAP_CHIP.h + MAP_CHIP.gap + 6), w: MAP_CHIP.w, h: MAP_CHIP.h };
      });
      ky += Math.ceil(chips.length / cols) * (MAP_CHIP.h + MAP_CHIP.gap + 6) + 70;
    }
    return pos;
  }
  arcHeight(a, b) { return a && b ? 50 + 0.28 * Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) : 0; }

  /* Route of one edge: curve + badge position. Works for any node position
   * (RF16.3 screens can be dragged): page->page links arc over (back links
   * under) the higher of the two screens; other links are vertical S-curves. */
  route(e, pos, lane) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return null;
    const cx = (n) => n.x + n.w / 2;
    const isPage = (id) => /^p\d+$/.test(id);
    if (e.kind === "swipe") {
      const y1 = a.y + a.h / 2 + lane * 18, y2 = b.y + b.h / 2 + lane * 18;
      const fwd = cx(b) >= cx(a);
      const x1 = fwd ? a.x + a.w + 6 : a.x - 6, x2 = fwd ? b.x - 6 : b.x + b.w + 6;
      return { d: `M${x1},${y1} L${x2},${y2}`, bx: (x1 + x2) / 2, by: (y1 + y2) / 2 };
    }
    if (isPage(e.from) && isPage(e.to)) {
      if (e.from === e.to) { // self loop (e.g. a popup hotkey on its own page)
        const x0 = a.x + a.w * 0.65, y0 = a.y;
        const d = `M${x0},${y0} C${x0 + 40},${y0 - 90 - lane * 20} ${x0 + 100},${y0 - 40} ${a.x + a.w},${y0 + 20}`;
        return { d, bx: x0 + 55, by: y0 - 60 - lane * 15 };
      }
      const under = e.kind === "back";
      const dir = cx(b) > cx(a) ? 1 : -1;
      const sx = cx(a) + 20 * dir, ex = cx(b) - 20 * dir;
      const sy = under ? a.y + a.h : a.y, ey = under ? b.y + b.h : b.y;
      const hgt = this.arcHeight(a, b) + lane * 26;
      const peak = under ? Math.max(sy, ey) + hgt : Math.min(sy, ey) - hgt;
      const qx = (sx + ex) / 2, qy = 2 * peak - (sy + ey) / 2;
      return { d: `M${sx},${sy} Q${qx},${qy} ${ex},${ey}`, bx: qx, by: peak };
    }
    if (a.y === b.y) { // special <-> special: arc under the row
      const y0 = a.y + a.h, sx = cx(a), ex = cx(b);
      const hgt = 40 + 0.15 * Math.abs(ex - sx) + lane * 20;
      return { d: `M${sx},${y0} Q${(sx + ex) / 2},${y0 + hgt * 2} ${ex},${y0}`, bx: (sx + ex) / 2, by: y0 + hgt };
    }
    const up = a.y > b.y;
    const sx = cx(a) + lane * 14, sy = up ? a.y : a.y + a.h;
    const ex = cx(b) + lane * 14, ey = up ? b.y + b.h : b.y;
    const my = (sy + ey) / 2;
    return { d: `M${sx},${sy} C${sx},${my} ${ex},${my} ${ex},${ey}`, bx: (sx + ex) / 2, by: my };
  }

  /* RF16.3 switches (remembered in the browser). */
  showOpts() {
    if (!this.show) {
      let saved = null;
      try { saved = JSON.parse(mapStore("acm-map-show") || "null"); } catch (e) { saved = null; }
      this.show = { pageKeys: true, globalKeys: true, edges: true, kinds: {}, ...(saved || {}) };
    }
    return this.show;
  }
  setShow(patch) {
    Object.assign(this.showOpts(), patch);
    mapStore("acm-map-show", JSON.stringify(this.show));
    this.build();
  }

  /* ---------- DOM ---------- */
  build() {
    const show = this.showOpts();
    this.keysPageIdx = this.keysPage();
    const graph = buildNavGraph(this.doc || {}, (k) => this.hwLabel(k),
      { chips: true, keysPage: show.pageKeys ? this.keysPageIdx : null, chipsGlobal: show.globalKeys });
    // RF15.3: one chip per hardware key, in two rows (selected page / global) - each row can be hidden
    const keys = (typeof HW_LAYOUT !== "undefined" ? HW_LAYOUT.flat() : []).concat(this.hwKeys || []).filter((k, i, a) => a.indexOf(k) === i);
    for (const scope of ["p", "g"]) {
      if (!(scope === "p" ? show.pageKeys : show.globalKeys)) continue;
      graph.nodes.push({ id: "row:" + scope, kind: "rowlabel", scope });
      for (const k of keys) graph.nodes.push({ id: `k${scope}:${k}`, kind: "keychip", scope, key: k });
    }
    this.graph = graph;
    this.pos = this.layout(graph);
    const world = el("div", { class: "navmap-world" });
    this.svg = svgEl("svg", { class: "navmap-edges" });
    const defs = svgEl("defs");
    const marker = svgEl("marker", { id: "navmap-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    marker.append(svgEl("path", { d: "M0,0 L10,5 L0,10 z", class: "navmap-arrowhead" }));
    defs.append(marker);
    this.svg.append(defs);
    world.append(this.svg);
    this.nodeEls = {};
    this.nodeDivs = {};
    for (const n of graph.nodes) {
      const d = this.nodeEl(n, this.pos[n.id]);
      this.nodeDivs[n.id] = d;
      world.append(d);
    }
    this.links = el("div", { class: "navmap-links" });
    world.append(this.links);
    this.world = world;
    this.renderLinks();
    this.renderShell();
    this.drawPreviews();
    this.applyView();
    if (!this.fitted) requestAnimationFrame(() => { if (this.viewport && this.viewport.clientWidth) { this.fit(); this.fitted = true; } });
    if (this.sel) this.highlight(this.sel);
  }

  /* Bounds, edges, badges and anchors from the current positions (redrawn
   * live while a screen is dragged). */
  renderLinks() {
    const { graph, pos } = this;
    const show = this.showOpts();
    const box = Object.values(pos).reduce((b, p) => ({
      x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x + p.w), y1: Math.max(b.y1, p.y + p.h),
    }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const maxArc = graph.edges.filter((e) => e.kind !== "back" && e.kind !== "swipe" && /^p\d+$/.test(e.from) && /^p\d+$/.test(e.to))
      .reduce((m, e) => Math.max(m, this.arcHeight(pos[e.from], pos[e.to]) + 60), 60);
    box.y0 -= maxArc + 30; box.x0 -= 60; box.x1 += 60; box.y1 += 160;
    this.bounds = box;
    const svg = this.svg;
    for (const k of ["width", "height", "viewBox", "style"]) svg.removeAttribute(k);
    svg.setAttribute("width", box.x1 - box.x0);
    svg.setAttribute("height", box.y1 - box.y0);
    svg.setAttribute("viewBox", `${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}`);
    svg.setAttribute("style", `left:${box.x0}px;top:${box.y0}px`);
    svg.querySelectorAll("path.navmap-edge").forEach((x) => x.remove());
    this.links.replaceChildren();
    this.edgeEls = [];
    const lanes = new Map();
    const visible = (e) => show.edges && show.kinds[e.kind] !== false;
    for (const e of graph.edges.filter(visible)) {
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
      badge.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this.holdFired) { this.holdFired = false; return; } // the hold already opened its dialog
        if (!this.moved) this.pickEdge(e);
      });
      // RF15.5: press and hold (600 ms, mouse or touch) -> remove dialog
      badge.addEventListener("pointerdown", () => {
        if (!this.editable()) return;
        clearTimeout(this.holdTimer);
        this.holdFired = false;
        this.holdTimer = setTimeout(() => { if (!this.moved) { this.holdFired = true; this.removeEdge(e); } }, MAP_HOLD_MS);
      });
      for (const ev of ["pointerup", "pointerleave", "pointercancel"]) badge.addEventListener(ev, () => clearTimeout(this.holdTimer));
      this.links.append(badge);
      this.edgeEls.push({ e, path, badge });
    }
    // RF15.1 anchors: left/right = swipe order, top = UI jumps, bottom = hotkeys
    if (this.editable()) {
      for (const n of graph.nodes.filter((x) => x.kind === "page")) {
        const p = pos[n.id];
        for (const [side, x, y] of [["left", p.x, p.y + p.h / 2], ["right", p.x + p.w, p.y + p.h / 2], ["top", p.x + p.w / 2, p.y], ["bottom", p.x + p.w / 2, p.y + p.h]]) {
          this.links.append(el("div", { class: `navmap-anchor a-${side}`, "data-p": n.p, "data-side": side, style: `left:${x}px;top:${y}px`,
            title: t("map_anchor_" + side) }));
        }
      }
    }
    if (this.sel) this.highlight(this.sel, true);
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
        if (n.id === "any" && n.label === "map_any_page") this.onSelect({ kind: "path", path: "/hotkeys" });
        else if (n.id === "ov_act") this.onSelect({ kind: "path", path: "/activities" });
      });
      return d;
    }
    if (n.kind === "rowlabel") {
      const page = (this.doc.pages || [])[this.keysPageIdx];
      return el("div", { class: "navmap-rowlabel", style }, n.scope === "p"
        ? t("map_keys_page", { name: page ? page.name || `#${this.keysPageIdx + 1}` : "—" }) : t("map_keys_global"));
    }
    if (n.kind === "keychip") {
      // RF16.3: the simulator's key icons (HW_LABEL), name as tooltip
      const icon = (typeof HW_LABEL !== "undefined" && HW_LABEL[n.key]) || n.key;
      // keys with a binding stand out; unbound ones are dimmed (drop targets only)
      // (any binding counts, also non-navigation ones: service, Harmony, IR, event...)
      const owner = n.scope === "g" ? this.doc : (this.doc.pages || [])[this.keysPageIdx];
      const hk = owner ? [...(owner.hotkeys || []), ...(owner.longHotkeys || [])].filter((h) => h && String(h.key).toUpperCase() === n.key) : [];
      const bound = hk.length > 0;
      const what = hk.map((h) => hotkeySummary(h)).join(" · ");
      const d = el("div", { class: `navmap-chip s-${n.scope}${bound ? " bound" : ""}`, style, title: `${this.hwLabel(n.key)} (${n.key})${what ? " — " + what : ""}` },
        el("strong", { class: "navmap-chip-icon", text: icon }), el("small", { text: this.hwLabel(n.key) }));
      if (this.editable()) d.append(el("div", { class: "navmap-anchor a-key", "data-scope": n.scope, "data-key": n.key, title: t("map_anchor_key") }));
      return d;
    }
    if (n.kind === "missing") {
      return el("div", { class: "navmap-special missing", style, title: t("map_missing") }, el("span", { class: "navmap-sicon", text: "⚠" }), el("span", { text: n.name }));
    }
    const badges = [n.start ? el("span", { title: t("map_start"), text: "⭐" }) : null,
      n.hidden ? el("span", { class: n.hidden.full ? "crossed" : "", title: `${t("map_hidden")} ${n.hidden.activity}${n.hidden.full ? " (hideMode: full)" : ""}`, text: "👁" }) : null];
    const label = el("div", { class: "navmap-label", title: t("map_drag_screen") }, el("span", { class: "navmap-idx", text: String(n.p + 1) }), el("strong", { text: n.name }), ...badges);
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
    if (!this.nodeEls || !this.screen || !this.open) { if (this.onPreviews) this.onPreviews(); return; }
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
    if (this.onPreviews) this.onPreviews(); // RF17 big preview pane
  }

  renderShell() {
    const toggle = el("button", { class: "icon", title: t("map_toggle"), text: this.open ? "▴" : "▾", onclick: () => {
      this.open = !this.open; mapStore(MAP_STORE.open, this.open ? "1" : "0"); this.renderShell(); if (this.open) this.drawPreviews();
    } });
    const head = el("div", { class: "row navmap-head" }, toggle, el("strong", { text: "🗺 " + t("map_title") }),
      el("span", { class: "muted", text: this.mode === "simulator" ? t("map_hint_sim") : t("map_hint_editor"),
        title: this.editable() ? t("map_hint_edit") : null }),
      el("span", { class: "spacer" }),
      ...(this.open && this.editable() ? this.pageButtons() : []),
      ...(this.open ? this.switches() : []),
      this.open ? el("button", { class: "icon", title: t("map_reset_layout"), text: "⟲", onclick: () => this.saveLayout(true) }) : null,
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

  /* RF15.6: big "+ New page" / "Delete page" buttons (same as the editor's). */
  pageButtons() {
    const pages = (this.doc && this.doc.pages) || [];
    const p = this.keysPage();
    const cur = p !== null ? pages[p] : null;
    return [
      el("button", { class: "navmap-big primary", text: "＋ " + t("map_new_page"), onclick: async () => {
        const next = mapAddPage(this.doc, t("page"));
        await this.onCommit(next);
        this.onSelect({ kind: "page", p: next.pages.length - 1 }); // the new page is selected
      } }),
      el("button", { class: "navmap-big danger", text: "🗑 " + t("map_delete_page"), disabled: !cur || pages.length < 2,
        title: pages.length < 2 ? t("map_delete_last") : cur ? `${t("map_delete_page")}: ${cur.name || ""}` : null,
        onclick: async () => {
          const name = cur.name || `#${p + 1}`;
          const incoming = (this.graph ? this.graph.edges : []).filter((e) => e.to === "p" + p && e.kind !== "swipe" && e.from !== e.to).length;
          if (!(await mapConfirm(t("map_delete_confirm", { name, n: incoming }), false, t("map_remove_btn")))) return;
          const next = mapDeletePage(this.doc, p);
          if (next) { await this.onCommit(next); this.onSelect({ kind: "page", p: Math.max(0, p - 1) }); }
        } }),
    ];
  }

  /* RF16.3 switches: page keys, global keys, connections (state kept in the browser). */
  switches() {
    const sh = this.showOpts();
    const tog = (key, icon, label) => el("button", { class: "icon navmap-toggle" + (sh[key] ? " on" : ""), title: label, "aria-pressed": sh[key] ? "true" : "false",
      onclick: () => this.setShow({ [key]: !sh[key] }) }, `${icon} ${label}`);
    return [tog("pageKeys", "☰", t("map_show_page_keys")), tog("globalKeys", "⏻", t("map_show_global_keys")), tog("edges", "〰", t("map_show_edges"))];
  }

  legend() {
    return el("div", { class: "navmap-legend" }, el("strong", { text: t("map_legend") }),
      this.editable() ? el("p", { class: "msg", text: "✎ " + t("map_hint_edit") }) : null,
      this.editable() ? el("div", { class: "row" }, el("span", { class: "navmap-anchor static", style: "position:static;margin:0;transform:none" }),
        el("span", { text: t("map_legend_anchors") })) : null,
      ...Object.entries(MAP_KINDS).map(([k, v]) => {
        // RF16.3: per-kind toggle
        const cb = el("input", { type: "checkbox", title: t("map_show_kind") });
        cb.checked = this.showOpts().kinds[k] !== false;
        cb.onchange = () => this.setShow({ kinds: { ...this.showOpts().kinds, [k]: cb.checked } });
        return el("label", { class: "row" }, cb, el("span", { class: `navmap-badge static k-${k}`, text: v.icon }), el("span", { text: t("map_k_" + k) }));
      }),
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
      // RF15: a drag that starts on an anchor or on a grid tile draws a link, not a pan
      const src = this.linkSource(e);
      if (src) { this.link = { ...src, sx: e.clientX, sy: e.clientY, id: e.pointerId, started: false }; this.moved = false; return; }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.moved = false;
      last = { x: e.clientX, y: e.clientY, dist: null, sx: e.clientX, sy: e.clientY };
    });
    vp.addEventListener("pointermove", (e) => {
      if (this.link && e.pointerId === this.link.id) return this.linkMove(e, vp);
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
      if (this.link && e.pointerId === this.link.id) return this.linkEnd(e);
      pts.delete(e.pointerId);
      if (!pts.size) { last = null; setTimeout(() => { this.moved = false; }, 0); }
      else if (last) last.dist = null;
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
  }

  /* ---------- RF15 editing ---------- */
  editable() { return this.mode === "editor" && typeof this.onCommit === "function" && (!this.canEdit || this.canEdit()); }
  keysPage() {
    const n = ((this.doc && this.doc.pages) || []).length;
    const p = this.sel && Number.isInteger(this.sel.p) ? this.sel.p : 0;
    return n ? Math.min(p, n - 1) : null;
  }
  toWorld(cx, cy) {
    const r = this.viewport.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.k, y: (cy - r.top - this.view.y) / this.view.k };
  }

  /* Where a link drag may start: side anchors, key chip anchors, grid tiles. */
  linkSource(e) {
    // RF16.3: the title bar of a screen moves it (any mode: layout only, not the dashboard)
    const lbl = e.target.closest && e.target.closest(".navmap-label");
    if (lbl) { const node = lbl.closest(".navmap-node"); return { kind: "move", p: +node.dataset.p, el: node }; }
    if (!this.editable()) return null;
    const a = e.target.closest && e.target.closest(".navmap-anchor");
    if (a && (a.dataset.side === "left" || a.dataset.side === "right")) return { kind: "side", p: +a.dataset.p, side: a.dataset.side, el: a };
    if (a && a.dataset.key) return { kind: "key", scope: a.dataset.scope, key: a.dataset.key, el: a };
    const node = e.target.closest && e.target.closest(".navmap-node");
    if (node) {
      const tile = this.tileAt(node, +node.dataset.p, e.clientX, e.clientY);
      if (tile) return { kind: "tile", ...tile };
    }
    return null;
  }

  /* Grid tile under a point inside a preview (row cards included) -> JSON path. */
  tileAt(node, p, x, y) {
    const page = node.querySelector(".sim-page");
    const cards = ((this.doc.pages || [])[p] || {}).cards || [];
    if (!page) return null;
    const inside = (elx) => { const r = elx.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
    const walk = (card, elem, path) => {
      if (!card || !elem) return null;
      const o = card.options || {};
      if (card.type === "row") {
        const kids = [...elem.children];
        const j = kids.findIndex(inside);
        return j >= 0 ? walk((o.cards || [])[j], kids[j], `${path}/options/cards/${j}`) : null;
      }
      const listKey = { button_grid: "buttons", scene_grid: "scenes" }[card.type];
      if (!listKey) return null;
      const kids = [...elem.children];
      const k = kids.findIndex(inside);
      const item = (o[listKey] || [])[k];
      if (k < 0 || !item || typeof item !== "object") return null;
      return { path: `${path}/options/${listKey}/${k}`, name: item.name || `#${k + 1}`, el: kids[k], scene: listKey === "scenes" };
    };
    const kids = [...page.children];
    const ci = kids.findIndex(inside);
    return ci >= 0 ? walk(cards[ci], kids[ci], `/pages/${p}/cards/${ci}`) : null;
  }

  /* Anchors a link of this kind can be dropped on. */
  dropOk(a, link) {
    const L = link || this.link;
    if (!L || !a.dataset.side) return false;
    if (L.kind === "side") return (a.dataset.side === (L.side === "right" ? "left" : "right")) && +a.dataset.p !== L.p;
    if (L.kind === "key") return a.dataset.side === "bottom";
    return a.dataset.side === "top";
  }
  linkMove(e, vp) {
    const L = this.link;
    if (L.kind === "move") return this.moveScreen(e, vp);
    if (!L.started) {
      if (Math.hypot(e.clientX - L.sx, e.clientY - L.sy) < 6) return;
      L.started = true;
      vp.setPointerCapture(e.pointerId);
      if (L.el) L.el.classList.add("dragging");
      this.world.querySelectorAll(".navmap-anchor").forEach((a) => a.classList.toggle("drop-ok", this.dropOk(a)));
      const from = this.toWorld(L.sx, L.sy);
      L.line = svgEl("path", { class: "navmap-drag" });
      L.from = from;
      this.world.querySelector(".navmap-edges").append(L.line);
    }
    const to = this.toWorld(e.clientX, e.clientY);
    L.line.setAttribute("d", `M${L.from.x},${L.from.y} L${to.x},${to.y}`);
    const hit = this.anchorAt(e.clientX, e.clientY);
    this.world.querySelectorAll(".navmap-anchor.hover").forEach((a) => a.classList.remove("hover"));
    if (hit && this.dropOk(hit)) hit.classList.add("hover");
  }
  anchorAt(x, y) {
    const els = document.elementsFromPoint(x, y);
    return els.map((x2) => x2.closest && x2.closest(".navmap-anchor")).find(Boolean) || null;
  }
  linkEnd(e) {
    const L = this.link;
    this.link = null;
    if (!L.started) return; // a plain click: the node's click handler selects the card
    if (L.kind === "move") {
      L.el.classList.remove("dragging");
      this.moved = true;
      setTimeout(() => { this.moved = false; }, 0);
      return this.saveLayout();
    }
    this.moved = true;
    setTimeout(() => { this.moved = false; }, 0);
    if (L.line) L.line.remove();
    if (L.el) L.el.classList.remove("dragging");
    this.world.querySelectorAll(".navmap-anchor").forEach((a) => a.classList.remove("drop-ok", "hover"));
    const hit = this.anchorAt(e.clientX, e.clientY);
    if (!hit || !this.dropOk(hit, L)) return;
    this.drop(L, +hit.dataset.p).catch((err) => toast(err.message, true));
  }

  /* RF16.3: drag a screen by its title bar; links follow live. */
  moveScreen(e, vp) {
    const L = this.link;
    if (!L.started) {
      if (Math.hypot(e.clientX - L.sx, e.clientY - L.sy) < 5) return;
      L.started = true; L.lx = L.sx; L.ly = L.sy;
      vp.setPointerCapture(e.pointerId);
      L.el.classList.add("dragging");
    }
    const p = this.pos["p" + L.p];
    p.x += (e.clientX - L.lx) / this.view.k; p.y += (e.clientY - L.ly) / this.view.k;
    L.lx = e.clientX; L.ly = e.clientY;
    L.el.style.left = `${p.x}px`; L.el.style.top = `${p.y}px`;
    if (!this.linksFrame) this.linksFrame = requestAnimationFrame(() => { this.linksFrame = null; this.renderLinks(); });
  }
  /* Positions of every screen, by page name, saved in the add-on (per remote). */
  async saveLayout(reset) {
    const layout = {};
    if (!reset) for (const n of this.graph.nodes.filter((x) => x.kind === "page")) layout[n.name] = { x: this.pos[n.id].x, y: this.pos[n.id].y };
    try {
      const res = await api("PUT", `api/remotes/${this.rid}/map-layout`, { layout });
      if (this.remote) this.remote.map_layout = res.layout;
      this.build(); // special/key rows move below the lowest screen
      if (reset) this.fit();
    } catch (err) { toast(err.message, true); }
  }

  /* RF15.2-15.4: apply a drop (asking what is needed), then one commit. */
  async drop(L, q) {
    const doc = this.doc;
    const target = doc.pages[q];
    const tname = target.name || `#${q + 1}`;
    if (L.kind === "side") {
      const after = L.side === "right";
      if ((after && q === L.p + 1) || (!after && q === L.p - 1)) return toast(t("map_already_neighbours"));
      return this.onCommit(mapMovePage(doc, L.p, q, after));
    }
    if (L.kind === "key") {
      const scope = L.scope === "p" ? this.keysPageIdx : null;
      const ans = await mapDialog(t("map_drop_key_title", { key: this.hwLabel(L.key), page: tname }), null, [
        { name: "press", label: t("map_press"), options: [["short", t("map_short")], ["long", t("map_long")]] },
        { name: "open", label: t("map_open_as"), options: [["page", t("map_as_page")], ["popup", t("map_as_popup")]] }]);
      if (!ans) return;
      const long = ans.press === "long";
      const old = mapHotkeyOf(doc, scope, L.key, long);
      if (old && !(await mapConfirm(t("map_replace_key", { key: this.hwLabel(L.key), what: hotkeySummary(old) }), false, t("map_replace_btn")))) return;
      return this.onCommit(mapSetHotkey(doc, scope, L.key, long, tname, ans.open === "popup"));
    }
    const tile = mapAt(doc, L.path);
    const ans = await mapDialog(t("map_drop_tile_title", { name: L.name, page: tname }),
      L.scene && tile.activity ? t("map_tile_activity_note") : null, [
        { name: "press", label: t("map_press"), options: [["tap", t("map_tap")], ["long", t("map_long_tap")]] },
        { name: "open", label: t("map_open_as"), options: [["page", t("map_as_page")], ["popup", t("map_as_popup")]] }]);
    if (!ans) return;
    const long = ans.press === "long";
    const cur = long ? (tile.long_press && (tile.long_press.page || tile.long_press.activity)) : tile.page;
    if (cur && !(await mapConfirm(t("map_replace_tile", { name: L.name, what: cur }), false, t("map_replace_btn")))) return;
    return this.onCommit(mapSetTileTarget(doc, L.path, long, tname, ans.open === "popup"));
  }

  /* RF15.5: press and hold on a connection. */
  async removeEdge(e) {
    const kind = e.orig || e.kind;
    if (kind === "swipe") return mapConfirm(t("map_swipe_cannot_remove"), true);
    const next = mapRemoveEdge(this.doc, e);
    if (!next) return mapConfirm(t("map_readonly_edge"), true);
    if (await mapConfirm(t("map_remove_confirm", { what: this.edgeTitle(e) }))) this.onCommit(next);
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
  highlight(sel, noRebuild) {
    this.sel = sel;
    if (!this.nodeEls) return;
    // RF15.3: the upper key row follows the page selected in the editor
    if (!noRebuild && this.graph && this.showOpts().pageKeys && this.keysPage() !== this.keysPageIdx) return this.build();
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

/* ---------- RF15 dialogs ---------- */

/* Short summary of what a hotkey does (replace confirmation). */
function hotkeySummary(h) {
  return h.page ? `→ ${h.page}${h.pageMode === "popup" ? " ▣" : ""}` : h.service || h.harmonyActivity || h.harmonyCommand || h.irCommand
    || h.event || h.openOverlay || h.stopActivity || JSON.stringify(h);
}

/* Radio choices -> {name: value} or null on cancel. */
function mapDialog(title, note, choices) {
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "navmap-dialog" }, el("h3", { text: title }), note ? el("p", { class: "msg warn", text: "⚠ " + note }) : null);
    const groups = choices.map((c) => {
      const inputs = c.options.map(([v, label], i) => {
        const r = el("input", { type: "radio", name: "m_" + c.name, value: v });
        r.checked = i === 0;
        return el("label", { class: "row" }, r, el("span", { text: label }));
      });
      dlg.append(el("fieldset", {}, el("legend", { text: c.label }), ...inputs));
      return c.name;
    });
    const done = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    dlg.append(el("div", { class: "row" }, el("span", { class: "spacer" }),
      el("button", { text: t("cancel"), onclick: () => done(null) }),
      el("button", { class: "primary", text: t("ok"), onclick: () => done(Object.fromEntries(groups.map((g) =>
        [g, dlg.querySelector(`input[name="m_${g}"]:checked`).value]))) })));
    dlg.addEventListener("cancel", () => done(null));
    document.body.append(dlg);
    dlg.showModal();
  });
}

/* Yes/No (or info only) dialog -> boolean. */
function mapConfirm(text, infoOnly, okLabel) {
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "navmap-dialog" }, el("p", { text }));
    const done = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    dlg.append(el("div", { class: "row" }, el("span", { class: "spacer" }),
      infoOnly ? null : el("button", { text: t("cancel"), onclick: () => done(false) }),
      el("button", { class: infoOnly ? "primary" : "primary danger-fill", text: infoOnly ? t("ok") : okLabel || t("map_remove_btn"), onclick: () => done(!infoOnly) })));
    dlg.addEventListener("cancel", () => done(false));
    document.body.append(dlg);
    dlg.showModal();
  });
}

/* ---------- RF17 big preview pane (Editor tab, left) ---------- */

/* A large, live picture of the screen selected in the editor, drawn by the
 * map's preview renderer (same live states). Clicking a card opens its form
 * (nothing is executed). Resizable by its right edge, hideable; width and
 * visibility are remembered in the browser. */
class BigPreview {
  /* opts: {map: NavMap, onSelect(target)} */
  constructor(opts) {
    Object.assign(this, opts);
    this.open = mapStore("acm-bigprev-open") !== "0";
    this.width = Math.min(520, Math.max(220, parseInt(mapStore("acm-bigprev-w") || "320", 10) || 320));
    this.sel = null;
    this.root = el("aside", { class: "bigprev" });
    this.map.onPreviews = () => this.draw(); // refreshed together with the map's previews
  }

  setSel(sel) { this.sel = sel; this.draw(); }

  page() {
    const pages = (this.map.doc && this.map.doc.pages) || [];
    const p = this.sel && Number.isInteger(this.sel.p) ? this.sel.p : 0;
    return pages[p] ? { page: pages[p], p } : null;
  }

  draw() {
    if (!this.open) {
      this.root.className = "bigprev closed";
      this.root.style.width = "";
      this.root.replaceChildren(el("button", { class: "bigprev-tab", title: t("bigprev_show"), text: "▸ " + t("bigprev_title"),
        onclick: () => { this.open = true; mapStore("acm-bigprev-open", "1"); this.draw(); } }));
      return;
    }
    this.root.className = "bigprev card";
    this.root.style.width = `${this.width}px`;
    const cur = this.page();
    const head = el("div", { class: "row bigprev-head" }, el("strong", { text: cur ? `${cur.p + 1}. ${cur.page.name || ""}` : t("bigprev_title") }),
      el("span", { class: "spacer" }),
      el("button", { class: "icon", title: t("bigprev_hide"), text: "◂", onclick: () => { this.open = false; mapStore("acm-bigprev-open", "0"); this.draw(); } }));
    if (!cur) { this.root.replaceChildren(head, el("p", { class: "muted", text: t("empty_list") })); return; }
    const sim = this.map.preview;
    const r = this.map.remote || {};
    let w = r.width || 480, h = r.height || 800;
    if (((r.orientation || "portrait") === "portrait") !== (h >= w)) [w, h] = [h, w];
    const inner = this.width - 26;
    const scale = inner / w;
    const th = sim.theme();
    const screen = el("div", { class: "sim-screen", style: `width:${w}px;height:${h}px;transform:scale(${scale});background:${th.background};color:${th.primaryText};--card:${th.cardSurface};--inset:${th.insetSurface};--ctl:${th.controlBackground};--muted:${th.mutedText};--acc:${th.accent};--amber:${th.amber};--danger:${th.danger};--ok:${th.success}` });
    try { screen.append(sim.renderPage(cur.page, cur.p, false)); } catch (e) { screen.append(el("p", { text: e.message })); }
    const frame = el("div", { class: "bigprev-screen", style: `width:${inner}px;height:${Math.round(h * scale)}px`, title: t("bigprev_hint") }, screen);
    frame.addEventListener("click", (ev) => {
      const c = this.map.cardAt(frame, ev.clientX, ev.clientY);
      this.onSelect(c !== null ? { kind: "card", p: cur.p, c } : { kind: "page", p: cur.p });
    });
    if (this.sel && this.sel.kind === "card") {
      const kid = screen.querySelector(".sim-page") && screen.querySelector(".sim-page").children[this.sel.c];
      if (kid) kid.classList.add("navmap-card-sel");
    }
    this.root.replaceChildren(head, frame, el("div", { class: "muted bigprev-foot", text: t("bigprev_hint") }));
    // RF17: width follows the drag handle (CSS resize) and is remembered
    if (!this.ro) {
      this.ro = new ResizeObserver(() => {
        const nw = Math.round(this.root.getBoundingClientRect().width);
        if (this.open && nw && Math.abs(nw - this.width) > 4) {
          this.width = Math.min(520, Math.max(220, nw));
          mapStore("acm-bigprev-w", this.width);
          clearTimeout(this.rt); this.rt = setTimeout(() => this.draw(), 120);
        }
      });
      this.ro.observe(this.root);
    }
  }
}
