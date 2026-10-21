/* Node checks for the map's pure functions (spec RF13 / RF15).
 * Run: node tests/map_mutations.test.js  (also called by tests/test_map_js.py) */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const clone = (o) => JSON.parse(JSON.stringify(o));
const ctx = { clone, console };
vm.createContext(ctx);
const src = fs.readFileSync(path.join(__dirname, "../astrion_config_manager/app/acm/static/map.js"), "utf8");
// only the pure part (graph model + document changes), before the DOM view
vm.runInContext(src.split("/* ---------- view ---------- */")[0] +
  "\nthis.api = {buildNavGraph, mapAddPage, mapDeletePage, mapMovePage, mapSetHotkey, mapHotkeyOf, mapSetTileTarget, mapRemoveEdge, mapAt};", ctx);
const M = ctx.api;

const doc = {
  startPage: 1,
  pages: [
    { name: "A", cards: [{ type: "scene_grid", options: { scenes: [{ name: "go", page: "C" }, { name: "hold", long_press: { page: "B", pageMode: "popup" } }] } }],
      hotkeys: [{ key: "MAIN", page: "C" }] },
    { name: "B", linkedPage: "C", parent: "A", openWhenEntity: "media_player.tv", openMode: "popup" },
    { name: "C", cards: [{ type: "row", options: { cards: [{ type: "button_grid", options: { buttons: [{ name: "x" }] } }] } }] },
  ],
  hotkeys: [{ key: "BACK", page: "A" }],
};
const hw = (k) => k;
// objects come from another vm realm: compare their JSON
const eq = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));

// RF15.3 graph: key chips as hotkey sources
let g = M.buildNavGraph(doc, hw, { chips: true, keysPage: 0 });
assert(g.edges.some((e) => e.from === "kp:MAIN" && e.to === "p2" && e.kind === "key"));
assert(g.edges.some((e) => e.from === "kg:BACK" && e.to === "p0"));
g = M.buildNavGraph(doc, hw);
assert(g.edges.some((e) => e.from === "p0" && e.kind === "key") && g.edges.some((e) => e.from === "any"));
// RF19.3: links created by grid tiles carry the tile pointer (anchor on the tile)
assert(M.buildNavGraph(doc, hw).edges.filter((e) => e.kind === "tap" || e.kind === "long").every((e) => e.tile && e.path.startsWith(e.tile)));
// 2.19.1: "Global keys" OFF in the map hides global hotkeys (never back on the "any" box)
g = M.buildNavGraph(doc, hw, { chips: true, keysPage: 0, chipsGlobal: false });
assert(g.edges.some((e) => e.from === "kp:MAIN") && !g.edges.some((e) => e.from === "any" || e.from.startsWith("kg:")));

// RF15.2 move: A.right -> C.left => A, C, B ; startPage follows B
let d = M.mapMovePage(doc, 0, 2, true);
eq(d.pages.map((p) => p.name), ["A", "C", "B"]);
assert.strictEqual(d.startPage, 2);
d = M.mapMovePage(doc, 0, 2, false); // A.left -> C.right => C, A, B
eq(d.pages.map((p) => p.name), ["C", "A", "B"]);
assert.strictEqual(d.startPage, 2);
d = M.mapMovePage(doc, 2, 0, true); // C.right -> A.left => B, C, A
eq(d.pages.map((p) => p.name), ["B", "C", "A"]);
assert.strictEqual(d.startPage, 0);

// RF15.3 hotkeys: replace existing, add new, popup
d = M.mapSetHotkey(doc, 0, "MAIN", false, "B", true);
eq(d.pages[0].hotkeys, [{ key: "MAIN", page: "B", pageMode: "popup" }]);
d = M.mapSetHotkey(doc, null, "PLAY", true, "C", false);
eq(d.longHotkeys, [{ key: "PLAY", page: "C" }]);
assert(M.mapHotkeyOf(doc, null, "BACK", false) && !M.mapHotkeyOf(doc, null, "BACK", true));

// RF15.4 tiles: tap and long tap, nested in a row card
const tile = "/pages/2/cards/0/options/cards/0/options/buttons/0";
d = M.mapSetTileTarget(doc, tile, false, "A", true);
eq(M.mapAt(d, tile), { name: "x", page: "A", pageMode: "popup" });
d = M.mapSetTileTarget(doc, tile, true, "B", false);
eq(M.mapAt(d, tile), { name: "x", long_press: { page: "B" } });

// RF15.5 removal
const edge = (kind, p) => ({ kind, path: p });
d = M.mapRemoveEdge(doc, edge("tap", "/pages/0/cards/0/options/scenes/0"));
eq(d.pages[0].cards[0].options.scenes[0], { name: "go" });
d = M.mapRemoveEdge(doc, edge("long", "/pages/0/cards/0/options/scenes/1/long_press"));
eq(d.pages[0].cards[0].options.scenes[1], { name: "hold" });
d = M.mapRemoveEdge(doc, edge("key", "/hotkeys/0"));
eq(d.hotkeys, []);
d = M.mapRemoveEdge(doc, edge("swipe_up", "/pages/1/linkedPage"));
assert(!("linkedPage" in d.pages[1]) && d.pages[1].parent === "A");
d = M.mapRemoveEdge(doc, edge("back", "/pages/1/parent"));
assert(!("parent" in d.pages[1]));
d = M.mapRemoveEdge(doc, edge("ha", "/pages/1/openWhenEntity"));
assert(!("openWhenEntity" in d.pages[1]) && !("openMode" in d.pages[1]));
assert.strictEqual(M.mapRemoveEdge(doc, edge("activity", "/activities/0")), null);
assert.strictEqual(M.mapRemoveEdge(doc, { kind: "swipe", path: null }), null);
d = M.mapRemoveEdge(doc, { kind: "broken", orig: "tap", path: "/pages/0/cards/0/options/scenes/0" });
assert.strictEqual(d.pages[0].cards[0].options.scenes[0].page, undefined);

// RF15.6 add / delete pages
d = M.mapAddPage({ pages: [{ name: "Page 2" }] }, "Page");
eq(d.pages.map((p) => p.name), ["Page 2", "Page 3"]);
d = M.mapDeletePage(doc, 0); // start page B (index 1) -> index 0
eq(d.pages.map((p) => p.name), ["B", "C"]);
assert.strictEqual(d.startPage, 0);
d = M.mapDeletePage(doc, 1); // deleting the start page -> 0
assert.strictEqual(d.startPage, 0);
assert.strictEqual(M.mapDeletePage({ pages: [{ name: "only" }] }, 0), null);

// the original document is never modified
assert.strictEqual(doc.pages[0].cards[0].options.scenes[0].page, "C");
console.log("map mutations: ok");
