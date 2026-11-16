/* Navigation map (spec RF13, RF15, RF20, RF21) - 3.0: the main, full-screen view.
 *
 * - RF21.2  full-screen map of the pages: zoom (wheel / pinch), pan (drag),
 *           zoom ± and "fit all"; screens dragged by their title bar, layout
 *           saved per remote (RF16.3), ⇅ hierarchy layout (RF20).
 * - RF21.3  every screen is drawn by the remote's own builder renderer
 *           (renderer.js), so previews match the installed app version.
 * - RF13.3  default layout: upstream keeps ONE continuous pager over the flat
 *           page list in file order -> one row, 👋 between swipe neighbours,
 *           ↩ to parents, every other link as an arc; special boxes below.
 * - RF13.4  one connection per way to reach a page (MAP_KINDS); dashed = popup.
 * - RF21.4  linking: drag a screen onto another one -> a chooser asks which
 *           element of the first opens the second (tile/button tap or long
 *           press, hardware key of the page or global, swipe up, parent/Back),
 *           page or popup, showing the value it replaces. Side anchors reorder
 *           the swipe order, key chips can still be dropped on a bottom anchor.
 *           Press and hold a connection to cut it (card-level page fields such
 *           as media_remote "details_page" can be cut, not created).
 *           Every change is written straight to the remote with a note
 *           (app.js liveWrite); the remote keeps the history.
 * - RF19.3  tile links start from a ● anchor on the tile.
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
  card: { icon: "🧩" },         // card-level page field (media_remote details_page, 1.5.8-beta)
  swipe_down: { icon: "👇" },   // swipe down -> Activities overlay
  back: { icon: "↩" },          // child -> parent (parentKey)
  broken: { icon: "⚠" },        // target page not found
};
const MAP_NODE_W = 220;          // preview width in map units
const MAP_BAND_COLORS = ["#26a69a", "#ab47bc", "#ffa726", "#42a5f5", "#ec407a", "#9ccc65", "#8d6e63", "#5c6bc0"]; // RF20.3
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
  // RF15: global hotkeys start from their key chip's global anchor ("kg:KEY"),
  // those of the selected page (opts.keysPage) from its page anchor ("kp:KEY"),
  // both on the same chip (2.19: one chip per key); other pages' from the page.
  const keysPage = opts && Number.isInteger(opts.keysPage) ? opts.keysPage : null;
  const chips = !!(opts && opts.chips);
  const chipsGlobal = chips && !(opts && opts.chipsGlobal === false);
  // RF16.3 (2.19.1): in the map (chips mode) the "Global keys" switch OFF hides
  // global hotkey links completely (they are never moved back onto the "any" box)
  const globalEdges = !chips || chipsGlobal;
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
  if (globalEdges) for (const [g, long] of [["hotkeys", false], ["longHotkeys", true]]) {
    (Array.isArray(doc[g]) ? doc[g] : []).forEach((hk, k) => hotkey(hk, chipsGlobal ? "kg:" + String(hk && hk.key).toUpperCase() : "any", long, `/${g}/${k}`));
  }
  // 1.2.9 settings fallback: long MAIN opens Settings when no hotkey does
  const allHk = [...(doc.hotkeys || []), ...(doc.longHotkeys || []), ...pages.flatMap((p) => [...(p.hotkeys || []), ...(p.longHotkeys || [])])];
  const longMain = [...(doc.longHotkeys || []), ...pages.flatMap((p) => p.longHotkeys || [])].some((h) => h && String(h.key).toUpperCase() === "MAIN");
  if (globalEdges && !allHk.some((h) => h && String(h.openOverlay || "").toLowerCase() === "settings") && !longMain) {
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
      // RF21.4: card-level page fields (1.5.8-beta media_remote "Page for ⋯" opens it as a popup)
      if (c && typeof o.details_page === "string" && o.details_page) {
        add(from, o.details_page, "card", { popup: true, label: `${c.type} ⋯`, path: `${cp}/options/details_page` });
      }
      const listKey = { button_grid: "buttons", scene_grid: "scenes" }[c && c.type];
      if (!listKey) return;
      (Array.isArray(o[listKey]) ? o[listKey] : []).forEach((it, k) => {
        if (!it || typeof it !== "object") return;
        const ip = `${cp}/options/${listKey}/${k}`;
        const label = it.name || "";
        // SceneGridCard: "activity" wins over "page" (the Activity's own page is shown)
        const act = listKey === "scenes" && it.activity && acts.find((a) => a.id === it.activity);
        // RF19.3: "tile" = pointer of the grid item the link starts from (map anchor on it)
        if (act && act.page) add(from, act.page, "activity", { label, path: ip, tile: ip });
        else if (it.page) add(from, it.page, "tap", { popup: popupOf(it.pageMode), label, path: ip, tile: ip });
        const lp = it.long_press;
        if (lp && typeof lp === "object") {
          const lact = lp.activity && acts.find((a) => a.id === lp.activity);
          if (lact && lact.page) add(from, lact.page, "activity", { label: `✋ ${label}`, path: `${ip}/long_press`, tile: ip });
          else if (lp.page) add(from, lp.page, "long", { popup: popupOf(lp.pageMode), label, path: `${ip}/long_press`, tile: ip });
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
  // in the map global hotkeys start from their chips (or are hidden): the
  // "any page" box then only stands for the swipe down (no duplicated keys)
  const anyBox = chips ? ["any", "map_any_swipe", "👇"] : ["any", "map_any_page", "🎛"];
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

/* RF21.4 swipe up from page a to `page` (page or popup). */
function mapSetLinked(doc, a, page, popup) {
  const d = clone(doc);
  const pg = d.pages[a];
  pg.linkedPage = page;
  if (popup) pg.linkedPageMode = "popup"; else delete pg.linkedPageMode;
  return d;
}
/* RF21.4 page a becomes a child of `page` (Back key -> parent; dots group). */
function mapSetParent(doc, a, page) {
  const d = clone(doc);
  d.pages[a].parent = page;
  return d;
}

/* RF15.5 removal; null = this connection cannot be removed from the map. */
function mapRemoveEdge(doc, e) {
  const kind = e.orig || e.kind;
  if (!e.path || !["tap", "long", "key", "swipe_up", "back", "ha", "card"].includes(kind)) return null;
  const d = clone(doc);
  if (kind === "key") {
    const parts = e.path.split("/");
    const idx = +parts.pop();
    const list = mapAt(d, parts.join("/"));
    if (!Array.isArray(list)) return null;
    list.splice(idx, 1);
    return d;
  }
  const objPath = ["swipe_up", "back", "ha", "card"].includes(kind) ? e.path.split("/").slice(0, -1).join("/") : e.path;
  const o = mapAt(d, objPath);
  if (!o || typeof o !== "object") return null;
  const drop = { tap: ["page", "pageMode"], long: ["page", "pageMode"], swipe_up: ["linkedPage", "linkedPageMode"],
    back: ["parent", "parentKey"], ha: ["openWhenEntity", "openWhenState", "closeWhenState", "openMode"],
    card: [e.path.split("/").pop()] }[kind];
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

/* ---------- RF20 hierarchy view (pure: doc in, drawing hints out) ---------- */

/* RF20.5 pages reached ONLY as a popup (every page-opening link is a popup;
 * swipe does not count) -> {index: {wf, hf}} popup size fractions. A page
 * opened only by swipe-up popups uses the SOURCE page's popupWidth/Height
 * (upstream Dashboard.kt LinkedPagePopupState); otherwise its own. Defaults
 * and clamping as DashboardLoader (0.7 / 0.5, 0.1..1). */
function mapPopupPages(doc) {
  const pages = Array.isArray(doc && doc.pages) ? doc.pages : [];
  const frac = (v, d) => (typeof v === "number" && isFinite(v) ? Math.min(1, Math.max(0.1, v)) : d);
  const g = buildNavGraph(doc, (k) => k, {});
  const out = {};
  pages.forEach((page, i) => {
    if (Number.isInteger(doc.startPage) ? doc.startPage === i : i === 0) return; // shown at boot as a page
    const inc = g.edges.filter((e) => e.to === "p" + i && e.kind !== "swipe" && e.from !== "p" + i);
    if (!inc.length || !inc.every((e) => e.popup)) return;
    const src = inc.every((e) => e.kind === "swipe_up") ? pages[+inc[0].from.slice(1)] : page;
    out[i] = { wf: frac(src && src.popupWidth, 0.7), hf: frac(src && src.popupHeight, 0.5) };
  });
  return out;
}

/* RF20.3 sibling groups = the remote's dot groups: index -> parent index
 * (only pages whose parent exists, not themselves). */
function mapParentOf(doc) {
  const pages = Array.isArray(doc && doc.pages) ? doc.pages : [];
  const byName = new Map(pages.map((p, i) => [String((p && p.name) || "").toLowerCase(), i]));
  const out = {};
  pages.forEach((p, i) => {
    const q = p && p.parent ? byName.get(String(p.parent).toLowerCase()) : undefined;
    if (q !== undefined && q !== i) out[i] = q;
  });
  return out;
}

/* RF20.1 "Arrange by hierarchy": {pageName: {x, y}} for the map layout.
 * Roots (no parent) on the main row in file order; children one row lower
 * under their parent (parent above its first child, columns in file order);
 * a linked page with no parent and no children goes above its first main-row
 * source, slightly offset (tree position wins). size(i) -> {w, h} of a node. */
function mapHierarchyLayout(doc, size, gap, rowGap) {
  const pages = Array.isArray(doc && doc.pages) ? doc.pages : [];
  const parent = mapParentOf(doc);
  const kids = pages.map(() => []);
  Object.entries(parent).forEach(([c, q]) => kids[q].push(+c));
  // cycles (A parent of B parent of A): those pages are treated as roots
  const inCycle = (i) => { const seen = new Set(); let j = i; while (parent[j] !== undefined) { if (seen.has(j)) return true; seen.add(j); j = parent[j]; } return false; };
  const isRoot = (i) => parent[i] === undefined || inCycle(i);
  const byName = new Map(pages.map((p, i) => [String((p && p.name) || "").toLowerCase(), i]));
  const above = {}; // linked page -> source
  pages.forEach((p, i) => {
    const l = p && p.linkedPage ? byName.get(String(p.linkedPage).toLowerCase()) : undefined;
    if (l === undefined || l === i || above[l] !== undefined) return;
    if (parent[l] === undefined && !kids[l].length && isRoot(i)) above[l] = i;
  });
  // a source that is itself placed above another page keeps its linked page in the row
  Object.keys(above).forEach((l) => { if (above[above[l]] !== undefined) delete above[l]; });
  const maxH = pages.reduce((m, _p, i) => Math.max(m, size(i).h), 0);
  const rowH = maxH + rowGap;
  const colW = pages.reduce((m, _p, i) => Math.max(m, size(i).w), 0) + gap;
  const pos = {};
  let col = 0;
  const placed = new Set();
  const place = (i, depth) => {
    if (placed.has(i)) return;
    placed.add(i);
    pos[i] = { x: col * colW, y: depth * rowH };
    const ch = kids[i].filter((c) => !placed.has(c) && !inCycle(c));
    if (!ch.length) { col += 1; return; }
    ch.forEach((c) => place(c, depth + 1));
  };
  pages.forEach((_p, i) => { if (isRoot(i) && above[i] === undefined) place(i, 0); });
  pages.forEach((_p, i) => { if (!placed.has(i) && above[i] === undefined) place(i, 0); }); // leftovers
  Object.entries(above).forEach(([l, src]) => {
    pos[l] = { x: pos[src].x + 30, y: pos[src].y - size(+l).h - Math.max(60, rowGap / 2) };
  });
  const out = {};
  pages.forEach((p, i) => { if (pos[i]) out[(p && p.name) || `#${i + 1}`] = pos[i]; });
  return out;
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
    this.open = true; // RF21.2: the map is the main, full-screen view
    this.root = el("div", { class: "card navmap navmap-full" });
    // RF21.3 screens drawn by the remote's own builder renderer (shared with the app)
    this.snaps = {};
  }
  close() { this.closed = true; }

  /* RF13.6: redraw on every new version; the view (zoom/pan) is kept. */
  setDoc(doc, remote, mode) {
    const changed = doc !== this.doc || remote !== this.remote || mode !== this.mode;
    if (doc !== this.doc) this.snaps = {}; // new document: draw the screens again
    this.doc = doc; this.remote = remote; this.mode = mode || "editor";
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
    this.popups = mapPopupPages(this.doc || {}); // RF20.5 popup-only pages
    graph.nodes.filter((n) => n.kind === "page").forEach((n) => {
      const sp = saved[n.name]; // RF16.3: dragged positions, by page name
      const sz = this.nodeSize(n.p);
      // row layout: a smaller popup node is centred in its slot
      pos[n.id] = sp ? { x: sp.x, y: sp.y, ...sz } : { x: x + (MAP_NODE_W - sz.w) / 2, y: 0, ...sz };
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
    // RF15.3 (2.19): ONE row, one chip per key; each chip has two anchors,
    // left = "this page only" (kp:KEY), right = "global" (kg:KEY). The anchor
    // halves get their own rects so key edges start from the right anchor.
    const chips = extra.filter((c) => c.kind === "keychip");
    if (chips.length) pos["row:k"] = { x: left, y: ky - 34, w: 600, h: 26 };
    chips.forEach((n, i) => {
      const c = { x: left + (i % cols) * (MAP_CHIP.w + MAP_CHIP.gap), y: ky + Math.floor(i / cols) * (MAP_CHIP.h + MAP_CHIP.gap + 6), w: MAP_CHIP.w, h: MAP_CHIP.h };
      pos[n.id] = c;
      pos["kp:" + n.key] = { x: c.x, y: c.y, w: c.w / 2, h: c.h };
      pos["kg:" + n.key] = { x: c.x + c.w / 2, y: c.y, w: c.w / 2, h: c.h };
    });
    return pos;
  }
  /* RF19.3: a link created by a grid tile starts from the tile's anchor in the
   * preview: straight up out of the screen, then the usual arc to the target's
   * top. Tile not visible in the preview (scrolled out) -> from the screen's
   * bottom edge, arcing under the row. */
  tileRoute(e, a, b, lane) {
    const t0 = this.tilePos && this.tilePos[e.tile];
    const cx = (n) => n.x + n.w / 2;
    const ex = cx(b) + lane * 10, ey = b.y;
    if (!t0) { // fallback: bottom edge of the screen
      const sx = cx(a) + 26 + lane * 12, sy = a.y + a.h;
      const peak = Math.max(sy, b.y + b.h) + this.arcHeight(a, b) * 0.6 + 40 + lane * 18;
      const ey2 = /^p\d+$/.test(e.to) ? b.y + b.h : b.y;
      return { d: `M${sx},${sy} C${sx},${peak} ${ex},${peak} ${ex},${ey2}`, bx: (sx + ex) / 2, by: peak - 10 };
    }
    const sx = t0.x + t0.w / 2, sy = t0.y + t0.h / 2;
    const top = Math.min(a.y, ey);
    const hgt = (e.from === e.to ? 70 : this.arcHeight(a, b)) + lane * 22;
    const peak = top - hgt;
    const ex2 = e.from === e.to ? a.x + a.w - 14 : ex;
    const d = `M${sx},${sy} L${sx},${a.y} C${sx},${peak} ${ex2},${peak} ${ex2},${ey}`;
    return { d, bx: (sx + ex2) / 2, by: peak + hgt * 0.25 };
  }

  /* RF19.3: where each linked grid tile sits inside its screen preview, as an
   * offset from the screen node (kept across screen drags). Measured after the
   * previews are drawn; tiles outside the visible preview are left out. */
  measureTiles() {
    this.tileOff = {};
    if (!this.nodeEls || !this.open) return;
    const tiles = new Set(this.graph.edges.filter((e) => e.tile).map((e) => e.tile));
    if (this.editable()) this.allTiles().forEach((x) => tiles.add(x));
    for (const path of tiles) {
      const m = path.match(/^\/pages\/(\d+)\/cards\//);
      const ne = m && this.nodeEls[m[1]];
      const elx = ne && this.tileEl(ne.d, path);
      if (!elx) continue;
      const nr = ne.d.getBoundingClientRect(), sr = ne.screen.getBoundingClientRect(), r = elx.getBoundingClientRect();
      const k = nr.width / this.pos["p" + m[1]].w; // current zoom (node width varies, RF20.5)
      if (!k || !r.width) continue;
      // visible part of the preview only (overflowing content is clipped)
      if (r.top < sr.top - 1 || r.bottom > sr.bottom + 1) continue;
      this.tileOff[path] = { p: +m[1], dx: (r.left - nr.left) / k, dy: (r.top - nr.top) / k, w: r.width / k, h: r.height / k };
    }
    console.debug(`[acm] map: ${Object.keys(this.tileOff).length}/${tiles.size} tile anchors measured`);
  }
  /* RF19.3 (2.26): the previews may be drawn before the map is laid out (just
   * appended, hidden tab): nothing measurable yet. Retry on the next frames
   * until the tiles can be measured (max ~1 s), then redraw the links. */
  remeasureLater(n) {
    cancelAnimationFrame(this.measureRaf);
    const want = this.graph ? this.graph.edges.some((e) => e.tile) : false;
    if (!want || Object.keys(this.tileOff || {}).length || n > 60) return;
    this.measureRaf = requestAnimationFrame(() => {
      if (!this.viewport || !this.viewport.isConnected || !this.viewport.clientWidth) return this.remeasureLater(n + 1);
      this.measureTiles();
      if (Object.keys(this.tileOff).length) { this.renderLinks(); console.debug(`[acm] map: tile anchors measured after ${n + 1} frame(s)`); }
      else this.remeasureLater(n + 1);
    });
  }

  /* Pointers of every grid item of every page (drag sources when editable). */
  allTiles() {
    const out = [];
    const walk = (cards, base) => (cards || []).forEach((c, ci) => {
      const o = (c && c.options) || {};
      if (c && c.type === "row") walk(o.cards, `${base}/${ci}/options/cards`);
      const lk = { button_grid: "buttons", scene_grid: "scenes" }[c && c.type];
      if (lk) (o[lk] || []).forEach((it, k) => { if (it && typeof it === "object") out.push(`${base}/${ci}/options/${lk}/${k}`); });
    });
    (this.doc.pages || []).forEach((p, i) => walk(p && p.cards, `/pages/${i}/cards`));
    return out;
  }
  /* DOM element of a grid item in a drawn screen (RF21.3 snapshot). */
  tileEl(node, path) {
    const ne = Object.values(this.nodeEls).find((x) => x.d === node);
    const root = ne && ne.screen.shadowRoot;
    if (!root) return null;
    const p = +node.dataset.p;
    const hit = acmTiles(root, (this.doc.pages || [])[p], p).find((x) => x.path === path);
    return hit ? hit.el : null;
  }

  /* RF20.5 node size: full screen, or the popup's size for popup-only pages. */
  nodeSize(p) {
    const { nh } = this.screen;
    const pp = this.popups && this.popups[p];
    if (!pp) return { w: MAP_NODE_W, h: nh };
    return { w: Math.round(MAP_NODE_W * pp.wf), h: Math.round((nh - 26) * pp.hf) + 26 };
  }

  /* RF20.1 "Arrange by hierarchy": positions saved like dragged ones (RF16.3). */
  async arrangeHierarchy() {
    const layout = mapHierarchyLayout(this.doc || {}, (i) => this.nodeSize(i), MAP_GAP, 150);
    console.info(`[acm] map: hierarchy layout for ${Object.keys(layout).length} page(s)`);
    try {
      const res = await api("PUT", `api/remotes/${this.rid}/map-layout`, { layout });
      if (this.remote) this.remote.map_layout = res.layout;
      this.build();
      this.fit();
    } catch (err) { toast(err.message, true); }
  }

  arcHeight(a, b) { return a && b ? 50 + 0.28 * Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) : 0; }

  /* Route of one edge: curve + badge position. Works for any node position
   * (RF16.3 screens can be dragged): page->page links arc over (back links
   * under) the higher of the two screens; other links are vertical S-curves. */
  route(e, pos, lane) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return null;
    const cx = (n) => n.x + n.w / 2;
    if (e.tile) { const r = this.tileRoute(e, a, b, lane); if (r) return r; }
    const isPage = (id) => /^p\d+$/.test(id);
    if (e.kind === "swipe" && (Math.abs(a.y - b.y) > 12 || cx(b) < cx(a))) {
      // RF20.4: neighbours not side by side on one row -> thin dotted chain
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
      const dx = Math.max(60, Math.abs(x2 - x1) / 2);
      return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, bx: (x1 + x2) / 2, by: (y1 + y2) / 2, chain: true };
    }
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
      // RF20.2 screens on different rows: short vertical curve between facing edges
      if (a.y >= b.y + b.h + 30 || b.y >= a.y + a.h + 30) {
        const up = a.y > b.y;
        const sx = cx(a) + lane * 14, sy = up ? a.y : a.y + a.h;
        const ex = cx(b) + lane * 14, ey = up ? b.y + b.h : b.y;
        const my = (sy + ey) / 2;
        return { d: `M${sx},${sy} C${sx},${my} ${ex},${my} ${ex},${ey}`, bx: (sx + ex) / 2, by: my };
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
    // RF15.3 (2.19): each hardware key appears ONCE; the switches only hide
    // its "page" / "global" anchor and edges (row hidden when both are off)
    const keys = (typeof HW_LAYOUT !== "undefined" ? HW_LAYOUT.flat() : []).concat(this.hwKeys || []).filter((k, i, a) => a.indexOf(k) === i);
    if (show.pageKeys || show.globalKeys) {
      graph.nodes.push({ id: "row:k", kind: "rowlabel" });
      for (const k of keys) graph.nodes.push({ id: "k:" + k, kind: "keychip", key: k });
    }
    this.graph = graph;
    this.pos = this.layout(graph);
    const world = el("div", { class: "navmap-world" });
    this.bands = el("div", { class: "navmap-bands" }); // RF20.3, under the screens
    world.append(this.bands);
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
    // RF19.3 (2.26): links that start from a tile are drawn ABOVE the screen
    // previews, so the segment from the tile's anchor to the screen edge shows
    this.svgTop = svgEl("svg", { class: "navmap-edges top" });
    world.append(this.svgTop);
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
    const svgTop = this.svgTop;
    if (svgTop) {
      for (const k of ["width", "height", "viewBox", "style"]) svgTop.setAttribute(k, svg.getAttribute(k));
      svgTop.replaceChildren();
    }
    this.links.replaceChildren();
    this.edgeEls = [];
    const lanes = new Map();
    // RF19.3: tile positions follow their screen (also while it is dragged)
    this.tilePos = {};
    for (const [path, o] of Object.entries(this.tileOff || {})) {
      const sp = pos["p" + o.p];
      if (sp) this.tilePos[path] = { x: sp.x + o.dx, y: sp.y + o.dy, w: o.w, h: o.h };
    }
    const visible = (e) => show.edges && show.kinds[e.kind] !== false;
    for (const e of graph.edges.filter(visible)) {
      const key = [e.from, e.to].sort().join("|") + (e.kind === "back" ? "b" : "");
      const lane = lanes.get(key) || 0;
      lanes.set(key, lane + 1);
      const r = this.route(e, pos, lane);
      if (!r) continue;
      const path = svgEl("path", { d: r.d, class: `navmap-edge k-${e.kind}${e.popup ? " popup" : ""}${r.chain ? " chain" : ""}`,
        "marker-end": "url(#navmap-arrow)", "marker-start": e.kind === "swipe" ? "url(#navmap-arrow)" : null });
      // RF19.3: from a measured tile anchor -> upper layer (over the preview)
      (e.tile && this.tilePos[e.tile] && svgTop ? svgTop : svg).append(path);
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
    // RF20.3 sibling groups (= the remote's dot groups): coloured strip under
    // each child screen; one joined band when the siblings sit side by side
    if (this.bands) this.bands.replaceChildren();
    const parentOf = mapParentOf(this.doc || {});
    const groups = {};
    Object.entries(parentOf).forEach(([c, q]) => { (groups[q] = groups[q] || []).push(+c); });
    Object.entries(groups).forEach(([q, kids], gi) => {
      const pname = ((this.doc.pages || [])[q] || {}).name || `#${+q + 1}`;
      const color = MAP_BAND_COLORS[gi % MAP_BAND_COLORS.length];
      const ps = kids.map((c) => pos["p" + c]).filter(Boolean).sort((u, v) => u.x - v.x);
      const joined = ps.length > 1 && ps.every((u) => Math.abs(u.y - ps[0].y) < 2 && Math.abs(u.y + u.h - (ps[0].y + ps[0].h)) < 2)
        && ps.every((u, i) => i === 0 || u.x - (ps[i - 1].x + ps[i - 1].w) <= MAP_GAP + 40);
      const strips = joined ? [{ x: ps[0].x, y: ps[0].y + ps[0].h, w: ps[ps.length - 1].x + ps[ps.length - 1].w - ps[0].x }]
        : ps.map((u) => ({ x: u.x, y: u.y + u.h, w: u.w }));
      for (const st of strips) {
        this.bands && this.bands.append(el("div", { class: "navmap-band", style: `left:${st.x}px;top:${st.y + 12}px;width:${st.w}px;--band:${color}`,
          title: t("map_band", { name: pname, n: kids.length }) }, el("span", { text: `▸ ${pname}` })));
      }
    });
    // RF19.3 tile anchors: on linked tiles always (filled), on the other tiles
    // only when editable (hollow); dragging one starts a tile link (RF15.4)
    const linked = new Set(graph.edges.filter(visible).map((e) => e.tile).filter(Boolean));
    for (const [path, tp] of Object.entries(this.tilePos)) {
      if (!linked.has(path) && !this.editable()) continue;
      const a = el("div", { class: `navmap-anchor a-tile${linked.has(path) ? " linked" : ""}`, "data-tile": path,
        style: `left:${tp.x + tp.w / 2}px;top:${tp.y + tp.h / 2}px`, title: t("map_anchor_tile") });
      a.addEventListener("click", (ev) => { ev.stopPropagation(); if (!this.moved) this.onSelect({ kind: "path", path }); });
      this.links.append(a);
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
      return el("div", { class: "navmap-rowlabel", style }, t("map_keys_row", { name: page ? page.name || `#${this.keysPageIdx + 1}` : "—" }));
    }
    if (n.kind === "keychip") {
      // RF16.3: the simulator's key icons (HW_LABEL), name as tooltip
      const icon = (typeof HW_LABEL !== "undefined" && HW_LABEL[n.key]) || n.key;
      // RF15.3 (2.19): one chip, two scopes. A scope is "bound" when it has any
      // binding (also non-navigation ones: service, Harmony, IR, event...);
      // unbound chips are dimmed (drop targets only).
      const show = this.showOpts();
      const scopes = [["p", show.pageKeys, (this.doc.pages || [])[this.keysPageIdx]], ["g", show.globalKeys, this.doc]].filter((x) => x[1]);
      const info = scopes.map(([sc, , owner]) => {
        const hk = owner ? [...(owner.hotkeys || []), ...(owner.longHotkeys || [])].filter((h) => h && String(h.key).toUpperCase() === n.key) : [];
        // 2.21: bindings that open no page (service, Harmony, IR, event...) have
        // no link to draw: marked with ⚡ on the scope's side instead
        const acts = hk.filter((h) => !mapHotkeyNavigates(h));
        return { sc, bound: hk.length > 0, act: acts.map((h) => hotkeySummary(h)).join(" · "), what: hk.map((h) => hotkeySummary(h)).join(" · ") };
      });
      const cls = info.filter((x) => x.bound).map((x) => " bound-" + x.sc).join("");
      const tip = info.filter((x) => x.bound).map((x) => `\n${x.sc === "p" ? "◧ " + t("map_scope_page") : "◨ " + t("map_scope_global")}: ${x.what}`).join("");
      const d = el("div", { class: `navmap-chip${cls ? " bound" + cls : ""}`, style, title: `${this.hwLabel(n.key)} (${n.key})${tip}` },
        el("strong", { class: "navmap-chip-icon", text: icon }), el("small", { text: this.hwLabel(n.key) }),
        ...info.filter((x) => x.act).map((x) => el("span", { class: `navmap-chip-act s-${x.sc}`, text: "⚡",
          title: `${x.sc === "p" ? t("map_scope_page") : t("map_scope_global")}: ${x.act}` })));
      if (this.editable()) {
        for (const x of info) {
          d.append(el("div", { class: `navmap-anchor a-key s-${x.sc}`, "data-scope": x.sc, "data-key": n.key,
            title: `${x.sc === "p" ? t("map_scope_page") : t("map_scope_global")} — ${t("map_anchor_key")}` }));
        }
      }
      return d;
    }
    if (n.kind === "missing") {
      return el("div", { class: "navmap-special missing", style, title: t("map_missing") }, el("span", { class: "navmap-sicon", text: "⚠" }), el("span", { text: n.name }));
    }
    const badges = [n.start ? el("span", { title: t("map_start"), text: "⭐" }) : null,
      n.hidden ? el("span", { class: n.hidden.full ? "crossed" : "", title: `${t("map_hidden")} ${n.hidden.activity}${n.hidden.full ? " (hideMode: full)" : ""}`, text: "👁" }) : null];
    // RF20.4 swipe-order number (①②③…); RF20.5 ▣ = shown only as a popup
    const num = n.p < 20 ? String.fromCharCode(0x2460 + n.p) : `(${n.p + 1})`;
    const isPop = this.popups && this.popups[n.p];
    const label = el("div", { class: "navmap-label", title: t("map_drag_screen") }, el("span", { class: "navmap-idx", text: num, title: t("map_swipe_order", { n: n.p + 1 }) }),
      el("strong", { text: (isPop ? "▣ " : "") + n.name, title: isPop ? t("map_popup_only") : null }), ...badges);
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
    const page = screen.shadowRoot && screen.shadowRoot.querySelector("#content");
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
  /* RF21.3: every screen is a static copy drawn by the remote's builder
   * renderer (one hidden renderer, pages drawn one after the other). */
  drawPreviews() {
    if (!this.nodeEls || !this.screen || !this.renderer) return;
    const { w, h } = this.screen;
    const doc = this.doc;
    const jobs = Object.entries(this.nodeEls).map(async ([p, { screen }]) => {
      if (!(doc.pages || [])[p]) return;
      const popup = this.popups && this.popups[p];
      let snap = this.snaps[p];
      if (!snap) {
        try { snap = await this.renderer.snapshot(doc, +p, { w, h, popup }); } catch (e) {
          screen.replaceChildren(el("p", { class: "navmap-render-err", text: e.message }));
          return;
        }
        if (doc !== this.doc || this.closed) return; // a newer document is being drawn
        this.snaps[p] = snap;
      }
      const node = this.pos["p" + p];
      this.renderer.mount(screen, snap, node ? node.w : MAP_NODE_W);
    });
    Promise.all(jobs).then(() => {
      if (doc !== this.doc || this.closed) return;
      // RF19.3: tile anchors need the drawn previews: measure, then redraw the links
      this.measureTiles();
      this.renderLinks();
      this.remeasureLater(0);
      if (this.sel) this.highlight(this.sel);
      console.debug(`[acm] map: ${Object.keys(this.snaps).length} screen(s) drawn by the remote's renderer`);
    });
  }

  renderShell() {
    const head = el("div", { class: "row navmap-head" }, el("strong", { text: "🗺 " + t("map_title") }),
      el("span", { class: "muted", text: this.mode === "simulator" ? t("map_hint_sim") : t("map_hint_editor"),
        title: this.editable() ? t("map_hint_edit") : null }),
      el("span", { class: "spacer" }),
      ...(this.open && this.editable() ? this.pageButtons() : []),
      ...(this.open ? this.switches() : []),
      this.open ? el("button", { class: "icon", title: t("map_arrange_hint"), text: "⇅ " + t("map_arrange"), onclick: () => this.arrangeHierarchy() }) : null,
      this.open ? el("button", { class: "icon", title: t("map_reset_layout"), text: "⟲", onclick: () => this.saveLayout(true) }) : null,
      this.open ? el("button", { class: "icon", title: t("map_zoom_out"), text: "−", onclick: () => this.zoomBy(1 / 1.25) }) : null,
      this.open ? el("button", { class: "icon", title: t("map_zoom_in"), text: "+", onclick: () => this.zoomBy(1.25) }) : null,
      this.open ? el("button", { class: "icon", title: t("map_fit"), text: "⤢ " + t("map_fit"), onclick: () => this.fit() }) : null,
      this.open ? el("button", { class: "icon", text: "? " + t("map_legend"), onclick: () => { this.legendOpen = !this.legendOpen; this.renderShell(); } }) : null);
    this.root.replaceChildren(head);
    if (!this.open) return;
    const vp = el("div", { class: "navmap-viewport" }, this.world);
    if (this.legendOpen) vp.append(this.legend());
    this.root.append(vp);
    this.viewport = vp;
    this.bindGestures(vp);
  }

  /* RF15.6: big "+ New page" / "Delete page" buttons (same as the editor's). */
  pageButtons() {
    const pages = (this.doc && this.doc.pages) || [];
    const p = this.keysPage();
    const cur = p !== null ? pages[p] : null;
    return [
      el("button", { class: "navmap-big primary", text: "＋ " + t("map_new_page"), onclick: async () => {
        const next = mapAddPage(this.doc, t("page"));
        await this.onCommit(next, `ACM: ${t("map_new_page")} ${next.pages[next.pages.length - 1].name}`);
        this.onSelect({ kind: "page", p: next.pages.length - 1 }); // the new page is selected
      } }),
      el("button", { class: "navmap-big danger", text: "🗑 " + t("map_delete_page"), disabled: !cur || pages.length < 2,
        title: pages.length < 2 ? t("map_delete_last") : cur ? `${t("map_delete_page")}: ${cur.name || ""}` : null,
        onclick: async () => {
          const name = cur.name || `#${p + 1}`;
          const incoming = (this.graph ? this.graph.edges : []).filter((e) => e.to === "p" + p && e.kind !== "swipe" && e.from !== e.to).length;
          if (!(await mapConfirm(t("map_delete_confirm", { name, n: incoming }), false, t("map_remove_btn")))) return;
          const next = mapDeletePage(this.doc, p);
          if (next) { await this.onCommit(next, `ACM: ${t("map_delete_page")} ${name}`); this.onSelect({ kind: "page", p: Math.max(0, p - 1) }); }
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
      el("div", { class: "row" }, el("span", { text: "⚡" }), el("span", { text: t("map_legend_action") })),
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
    if (a && a.dataset.tile) { // RF19.3 / RF21.4: page link with this tile preselected
      return { kind: "page", p: +a.dataset.tile.split("/")[2], el: a, tile: a.dataset.tile };
    }
    // RF21.4: a drag from a screen's body links that page to the one it is
    // dropped on (a chooser asks which element); started on a tile, that tile
    // is preselected
    const node = e.target.closest && e.target.closest(".navmap-node");
    if (node) {
      const p = +node.dataset.p;
      const tile = this.tileAt(node, p, e.clientX, e.clientY);
      return { kind: "page", p, el: node, tile: tile ? tile.path : null };
    }
    return null;
  }

  /* Grid tile under a point inside a drawn screen (row cards: the nested card) -> JSON path. */
  tileAt(node, p, x, y) {
    const ne = this.nodeEls[p];
    const root = ne && ne.screen.shadowRoot;
    if (!root) return null;
    const inside = (elx) => { const r = elx.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
    const hit = acmTiles(root, (this.doc.pages || [])[p], p).find((tl) => inside(tl.el));
    if (!hit) return null;
    const item = mapAt(this.doc, hit.path) || {};
    const k = +hit.path.split("/").pop();
    return { path: hit.path, name: item.name || item.type || `#${k + 1}`, el: hit.el, nested: !!hit.nested };
  }

  /* Anchors a link of this kind can be dropped on. */
  dropOk(a, link) {
    const L = link || this.link;
    if (L && L.kind === "page") return !!(a && a.classList.contains("navmap-node"));
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
      this.world.querySelectorAll(".navmap-anchor, .navmap-node").forEach((a) => a.classList.toggle("drop-ok", this.dropOk(a)));
      const from = this.toWorld(L.sx, L.sy);
      L.line = svgEl("path", { class: "navmap-drag" });
      L.from = from;
      this.world.querySelector(".navmap-edges").append(L.line);
    }
    const to = this.toWorld(e.clientX, e.clientY);
    L.line.setAttribute("d", `M${L.from.x},${L.from.y} L${to.x},${to.y}`);
    const hit = this.anchorAt(e.clientX, e.clientY);
    this.world.querySelectorAll(".navmap-anchor.hover, .navmap-node.hover").forEach((a) => a.classList.remove("hover"));
    if (hit && this.dropOk(hit)) hit.classList.add("hover");
  }
  anchorAt(x, y, link) {
    const els = document.elementsFromPoint(x, y);
    const L = link || this.link;
    if (L && L.kind === "page") {
      // RF21.4: page links drop anywhere on a screen (its anchors included)
      for (const x2 of els) {
        const a = x2.closest && x2.closest(".navmap-anchor[data-p]");
        if (a) return this.nodeEls[a.dataset.p] ? this.nodeEls[a.dataset.p].d : null;
        const n = x2.closest && x2.closest(".navmap-node");
        if (n) return n;
      }
      return null;
    }
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
    this.world.querySelectorAll(".navmap-anchor, .navmap-node").forEach((a) => a.classList.remove("drop-ok", "hover"));
    const hit = this.anchorAt(e.clientX, e.clientY, L);
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
      return this.onCommit(mapMovePage(doc, L.p, q, after), `ACM: ${t("map_note_move", { name: doc.pages[L.p].name || "#" + (L.p + 1), target: tname })}`);
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
      return this.onCommit(mapSetHotkey(doc, scope, L.key, long, tname, ans.open === "popup"),
        `ACM: ${this.hwLabel(L.key)}${long ? " (" + t("map_long") + ")" : ""} → ${tname}`);
    }
    if (L.kind === "page") return this.pageLink(L.p, q, L.tile);
  }

  /* RF21.4 page A dropped on page B: which element of A opens B, and how. */
  async pageLink(a, q, tilePath) {
    const doc = this.doc;
    const pages = doc.pages || [];
    const from = pages[a] || {}, fname = from.name || `#${a + 1}`, tname = pages[q].name || `#${q + 1}`;
    const ans = await mapLinkDialog({ doc, a, q, fname, tname, tilePath, hwLabel: (k) => this.hwLabel(k),
      tiles: this.allTiles().filter((x) => x.startsWith(`/pages/${a}/`)) });
    if (!ans) return;
    let next = null, what = "";
    if (ans.kind === "tile") {
      next = mapSetTileTarget(doc, ans.path, ans.long, tname, ans.popup);
      const it = mapAt(doc, ans.path) || {};
      what = `${ans.long ? t("map_long_tap") : t("map_tap")} "${it.name || ans.path.split("/").pop()}"`;
    } else if (ans.kind === "key") {
      next = mapSetHotkey(doc, ans.global ? null : a, ans.key, ans.long, tname, ans.popup);
      what = `${ans.long ? t("map_long") : t("map_short")} ${this.hwLabel(ans.key)}${ans.global ? " (" + t("map_scope_global") + ")" : ""}`;
    } else if (ans.kind === "swipe_up") {
      next = mapSetLinked(doc, a, tname, ans.popup);
      what = t("map_k_swipe_up");
    } else if (ans.kind === "parent") {
      next = mapSetParent(doc, a, tname);
      what = t("map_k_back");
    }
    if (!next) return;
    await this.onCommit(next, `ACM: ${fname} → ${tname} · ${what}${ans.popup ? " ▣" : ""}`);
  }

  /* RF15.5: press and hold on a connection. */
  async removeEdge(e) {
    const kind = e.orig || e.kind;
    if (kind === "swipe") return mapConfirm(t("map_swipe_cannot_remove"), true);
    const next = mapRemoveEdge(this.doc, e);
    if (!next) return mapConfirm(t("map_readonly_edge"), true);
    if (await mapConfirm(t("map_remove_confirm", { what: this.edgeTitle(e) }))) this.onCommit(next, `ACM: ${t("map_note_cut")} ${this.edgeTitle(e)}`);
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
        const page = ne.screen.shadowRoot && ne.screen.shadowRoot.querySelector("#content");
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

/* ---------- RF15 / RF21 dialogs ---------- */

/* RF21.4 Link page A -> page B: choose the element of A and its details.
 * The current value it would replace is shown next to every choice.
 * Resolves {kind: "tile"|"key"|"swipe_up"|"parent", path, key, global, long, popup} or null. */
function mapLinkDialog(o) {
  const { doc, a, fname, tname } = o;
  const page = doc.pages[a] || {};
  const cur = (v) => (v ? `${t("map_now")}: ${v}` : t("map_now_none"));
  const radio = (v, checked) => el("input", { type: "radio", name: "acm-link-kind", value: v, checked });
  const sel = (opts, value) => el("select", {}, ...opts.map(([v, l]) => el("option", { value: v, text: l, selected: v === value })));
  const pressTile = sel([["tap", t("map_tap")], ["long", t("map_long_tap")]]);
  const pressKey = sel([["short", t("map_short")], ["long", t("map_long")]]);
  const scope = sel([["page", `${t("map_scope_page")} (${fname})`], ["global", t("map_scope_global")]]);
  const keys = HW_LAYOUT.flat();
  const keySel = sel(keys.map((k) => [k, `${HW_LABEL[k] || ""} ${o.hwLabel(k)}`]));
  const openAs = sel([["page", t("map_as_page")], ["popup", t("map_as_popup")]]);
  // tiles of A (nested row cards included); a drag started on a row's nested card picks its first tile
  const tiles = o.tiles;
  const pre = o.tilePath ? (tiles.find((x) => x === o.tilePath) || tiles.find((x) => x.startsWith(o.tilePath + "/"))) : null;
  const tileName = (path) => { const it = mapAt(doc, path) || {}; return it.name || `${path.includes("/scenes/") ? "scene" : "button"} #${+path.split("/").pop() + 1}`; };
  const tileSel = sel(tiles.map((x) => [x, tileName(x)]), pre || tiles[0]);
  const tileNow = el("span", { class: "muted" }), keyNow = el("span", { class: "muted" });
  const upd = () => {
    const it = tiles.length ? mapAt(doc, tileSel.value) || {} : {};
    const lp = it.long_press || {};
    const act = (id) => { const x = (doc.activities || []).find((y) => y.id === id); return x ? `🎬 ${x.name || id}` : null; };
    tileNow.textContent = cur(pressTile.value === "long" ? (lp.page || act(lp.activity)) : (act(it.activity) || it.page));
    const owner = scope.value === "global" ? doc : page;
    const list = (owner[pressKey.value === "long" ? "longHotkeys" : "hotkeys"] || []);
    const hk = list.find((h) => h && hwKey(h.key) === keySel.value);
    keyNow.textContent = cur(hk ? hotkeySummary(hk) : null);
  };
  [pressTile, tileSel, pressKey, scope, keySel].forEach((x) => x.addEventListener("change", upd));
  const kinds = [
    tiles.length ? el("fieldset", {}, el("legend", {}, el("label", { class: "row" }, radio("tile", !!pre || tiles.length > 0), "👆 " + t("map_link_tile"))),
      el("div", { class: "row" }, tileSel, pressTile), tileNow) : el("p", { class: "muted", text: t("map_link_no_tiles") }),
    el("fieldset", {}, el("legend", {}, el("label", { class: "row" }, radio("key", !tiles.length), "🎛 " + t("map_link_key"))),
      el("div", { class: "row" }, keySel, pressKey, scope), keyNow),
    el("fieldset", {}, el("legend", {}, el("label", { class: "row" }, radio("swipe_up", false), "☝️ " + t("map_k_swipe_up"))),
      el("span", { class: "muted", text: cur(page.linkedPage ? `${page.linkedPage}${page.linkedPageMode === "popup" ? " ▣" : ""}` : null) })),
    el("fieldset", {}, el("legend", {}, el("label", { class: "row" }, radio("parent", false), "↩ " + t("map_link_parent", { name: tname }))),
      el("span", { class: "muted", text: cur(page.parent) })),
  ];
  upd();
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "navmap-dialog navmap-link-dialog" },
      el("h3", { text: t("map_link_title", { from: fname, to: tname }) }),
      el("p", { class: "muted", text: t("map_link_hint") }), ...kinds,
      el("div", { class: "row" }, el("label", { text: t("map_open_as") }), openAs));
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(el("div", { class: "row" }, el("span", { class: "spacer" }),
      el("button", { text: t("cancel"), onclick: () => done(null) }),
      el("button", { class: "primary", text: t("map_link_btn"), onclick: () => {
        const kind = (dlg.querySelector("input[name=acm-link-kind]:checked") || {}).value;
        if (!kind) return;
        const popup = openAs.value === "popup";
        if (kind === "tile") done({ kind, path: tileSel.value, long: pressTile.value === "long", popup });
        else if (kind === "key") done({ kind, key: keySel.value, long: pressKey.value === "long", global: scope.value === "global", popup });
        else done({ kind, popup: kind === "swipe_up" && popup });
      } })));
    dlg.addEventListener("cancel", () => done(null));
    document.body.append(dlg);
    dlg.showModal();
  });
}

/* Short summary of what a hotkey does (replace confirmation). */
/* Whether a hotkey opens a page/overlay (= has a link on the map). */
function mapHotkeyNavigates(h) {
  const ov = String((h && h.openOverlay) || "").toLowerCase();
  return !!(h && (h.page || h.openCurrentActivityRoom || ov === "activities" || ov === "settings"));
}
function hotkeySummary(h) {
  if (h.page) return `→ ${h.page}${h.pageMode === "popup" ? " ▣" : ""}`;
  if (h.service) return `${h.service}${h.entityId ? " " + h.entityId : ""}`;
  if (h.harmonyActivity) return `Harmony ▶ ${h.harmonyActivity}`;
  if (h.harmonyCommand) return `Harmony ${h.harmonyCommand}`;
  if (h.irCommand) return `IR ${h.irCommand}`;
  if (h.event) return `event ${h.event}`;
  if (h.openOverlay) return `overlay ${h.openOverlay}`;
  if (h.stopActivity) return `■ Activity ${h.stopActivity}`;
  return JSON.stringify(h);
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
