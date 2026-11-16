/* Full-screen navigation test (spec RF21.5).
 *
 * The screen is the remote's own builder renderer (acm-render.html through the
 * proxy, RF21.3), driven live: taps and long presses on tiles, swipes
 * (left / right = flat pager in file order, up = linkedPage), the HA100 keys
 * (page hotkeys over global ones, long press, BACK -> parent / closes a popup),
 * popups at their size and position, the Activities overlay.
 * NAVIGATION ONLY: nothing is sent to any device; an action that is not a
 * page change is only named ("not executed").
 *
 * Upstream behaviour followed (Dashboard.kt / MainActivity, 1.5.8-beta):
 * - swipe pager = all pages in file order, "full"-hidden pages skipped;
 * - dots = pages with the same parent (hiddenUnlessActivity hides the dot);
 * - SceneGrid "activity" opens the Activity's page; tile/key pageMode popup;
 * - a popup key pressed again closes its popup; long MAIN opens Settings
 *   when no hotkey does (bindSettingsFallback).
 */
"use strict";

class NavSim {
  /* opts: {rid, remote, doc, start, onPage(p)} */
  constructor(opts) {
    Object.assign(this, opts);
    this.cur = Number.isInteger(opts.start) ? opts.start : (Number.isInteger((opts.doc || {}).startPage) ? opts.doc.startPage : 0);
    this.popup = null;     // {page, wf, hf, pos}
    this.overlay = null;   // "activities" | "settings"
    this.active = {};      // room -> Activity id (navigation state only)
    this.history = [];
    this.root = el("div", { class: "sim3" });
    this.build();
  }
  close() { this.closed = true; }

  pages() { return (this.doc && this.doc.pages) || []; }
  pageIndex(name) {
    const n = String(name || "").toLowerCase();
    return this.pages().findIndex((p) => String(p.name || "").toLowerCase() === n);
  }
  setDoc(doc, remote) {
    this.doc = doc; this.remote = remote;
    if (this.cur >= this.pages().length) this.cur = 0;
    if (this.popup && !this.pages()[this.popup.page]) this.popup = null;
    this.draw();
  }

  /* ---------- layout ---------- */
  build() {
    const { w, h } = remoteSize(this.remote);
    this.size = { w, h };
    this.frame = el("iframe", { class: "sim3-frame", src: renderUrl(this.rid), title: t("sim3_screen") });
    this.popFrame = el("iframe", { class: "sim3-frame sim3-popframe", src: renderUrl(this.rid), title: t("sim3_popup") });
    this.popBox = el("div", { class: "sim3-popup", hidden: true }, this.popFrame,
      el("button", { class: "sim3-popclose", text: "✕", title: t("close"), onclick: () => this.closePopup() }));
    this.scrim = el("div", { class: "sim3-scrim", hidden: true, onclick: () => this.closePopup() });
    this.overlayBox = el("div", { class: "sim3-overlay", hidden: true });
    this.screen = el("div", { class: "sim3-screen", style: `aspect-ratio:${w}/${h}` }, this.frame, this.scrim, this.popBox, this.overlayBox);
    this.dotsBox = el("div", { class: "sim3-dots" });
    this.title = el("div", { class: "sim3-title" });
    this.status = el("div", { class: "sim3-status muted" });
    const nav = el("div", { class: "row sim3-nav" },
      el("button", { title: t("sim3_swipe_right"), text: "◀ 👋", onclick: () => this.swipe(-1) }),
      el("button", { title: t("sim3_swipe_up"), text: "☝️", onclick: () => this.swipeUp() }),
      el("button", { title: t("sim3_swipe_down"), text: "👇", onclick: () => this.openOverlay("activities") }),
      el("button", { title: t("sim3_swipe_left"), text: "👋 ▶", onclick: () => this.swipe(1) }),
      el("button", { title: t("sim3_restart"), text: "⟲", onclick: () => this.restart() }));
    this.root.append(
      el("div", { class: "sim3-left" }, this.screen, this.dotsBox),
      el("div", { class: "sim3-side" }, this.title, el("p", { class: "muted", text: t("sim3_hint") }), nav, this.keys(), this.status));
    const ready = (fr) => new Promise((resolve) => fr.addEventListener("load", () => {
      const w2 = fr.contentWindow;
      if (!w2 || !w2.ACM) { this.status.textContent = t("render_unavailable"); return; }
      w2.ACM.ready.then(() => resolve(w2));
    }));
    this.mainWin = ready(this.frame);
    this.popWin = ready(this.popFrame);
    this.mainWin.then((w2) => { this.bindGestures(w2); this.draw(); });
  }

  /* ---------- drawing ---------- */
  async draw() {
    if (this.closed) return;
    const pages = this.pages();
    const page = pages[this.cur] || {};
    this.title.replaceChildren(el("strong", { text: `${this.cur + 1}. ${page.name || ""}` }),
      ...(this.popup ? [el("span", { class: "muted", text: ` ▣ ${(pages[this.popup.page] || {}).name || ""}` })] : []));
    this.dotsBox.replaceChildren(...this.dotPages().map((i) => el("span", { class: i === this.cur ? "on" : "", title: (pages[i] || {}).name })));
    const w = await this.mainWin;
    w.ACM.render(this.doc, this.cur, { w: this.size.w, h: this.size.h, sim: true });
    this.bindTiles(w, this.cur);
    if (this.popup) {
      const pw = await this.popWin;
      const pos = this.popup.pos || "center";
      this.popBox.className = `sim3-popup pos-${pos}`;
      this.popBox.style.width = `${this.popup.wf * 100}%`;
      this.popBox.style.height = `${this.popup.hf * 100}%`;
      this.popBox.hidden = false; this.scrim.hidden = false;
      pw.ACM.render(this.doc, this.popup.page, { w: this.size.w, h: this.size.h, popup: { wf: this.popup.wf, hf: this.popup.hf }, sim: true });
      this.bindTiles(pw, this.popup.page);
    } else { this.popBox.hidden = true; this.scrim.hidden = true; }
    this.drawOverlay();
    if (this.onPage) this.onPage(this.cur);
  }

  /* Taps and long presses on the drawn tiles (ACM.tiles(): DOM order -> pointer). */
  bindTiles(w, p) {
    for (const tl of w.ACM.tiles()) {
      tl.el.classList.add("acm-tap");
      let timer = null, long = false;
      tl.el.addEventListener("pointerdown", () => {
        long = false;
        timer = setTimeout(() => { long = true; this.tapTile(tl.path, true, tl.nested); }, LONG_PRESS_MS);
      });
      tl.el.addEventListener("pointerup", () => {
        clearTimeout(timer);
        if (!long && !this.swiped) this.tapTile(tl.path, false, tl.nested);
      });
      tl.el.addEventListener("pointerleave", () => clearTimeout(timer));
    }
  }

  /* Swipes inside the screen (mouse drag or touch). */
  bindGestures(w) {
    let g = null;
    w.document.addEventListener("pointerdown", (e) => { g = { x: e.clientX, y: e.clientY }; this.swiped = false; });
    w.document.addEventListener("pointerup", (e) => {
      if (!g) return;
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      g = null;
      if (this.popup || this.overlay) return;
      if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) { this.swiped = true; this.swipe(dx < 0 ? 1 : -1); }
      else if (dy < -60 && Math.abs(dy) > 1.5 * Math.abs(dx)) { this.swiped = true; this.swipeUp(); }
      else if (dy > 60 && Math.abs(dy) > 1.5 * Math.abs(dx)) { this.swiped = true; this.openOverlay("activities"); }
      setTimeout(() => { this.swiped = false; }, 0);
    });
  }

  /* ---------- navigation ---------- */
  activeIds() { return new Set(Object.values(this.active).filter(Boolean)); }
  fullyHidden(p) { return !!(p && p.hiddenUnlessActivity && p.hideMode === "full" && !this.activeIds().has(p.hiddenUnlessActivity)); }
  siblings() { return this.pages().map((p, i) => i).filter((i) => i === this.cur || !this.fullyHidden(this.pages()[i])); }
  dotPages() {
    const pages = this.pages(); const cur = pages[this.cur] || {}; const act = this.activeIds();
    return this.siblings().filter((i) => {
      const p = pages[i];
      return (p.parent || null) === (cur.parent || null) && (i === this.cur || !p.hiddenUnlessActivity || act.has(p.hiddenUnlessActivity));
    });
  }
  log(msg) { this.status.textContent = msg; console.debug(`[acm] sim: ${msg}`); }

  /* Page change; `src` (page index) gives a swipe-up popup its source's size. */
  goto(name, mode, src) {
    const idx = this.pageIndex(name);
    if (idx < 0) { toast(`${t("sim3_page_missing")}: ${name}`, true); return; }
    this.overlay = null;
    if (mode === "popup") {
      const geo = this.pages()[src !== undefined ? src : idx] || {};
      this.popup = { page: idx, wf: popupFrac(geo.popupWidth, 0.7), hf: popupFrac(geo.popupHeight, 0.5), pos: geo.popupPosition || "center" };
      this.log(`▣ ${name}`);
    } else {
      this.history.push(this.cur);
      this.cur = idx; this.popup = null;
      this.log(`→ ${name}`);
    }
    this.draw();
  }
  closePopup() { if (this.popup) { this.popup = null; this.log(t("sim3_popup_closed")); this.draw(); } }
  swipe(dir) {
    const sib = this.siblings(); const next = sib[sib.indexOf(this.cur) + dir];
    if (next === undefined) return this.log(t("sim3_no_page"));
    this.cur = next; this.popup = null; this.log(`👋 ${(this.pages()[next] || {}).name}`); this.draw();
  }
  swipeUp() {
    const p = this.pages()[this.cur];
    if (p && p.linkedPage) this.goto(p.linkedPage, p.linkedPageMode === "popup" ? "popup" : "page", this.cur);
    else this.log(t("sim3_no_linked"));
  }
  restart() {
    this.cur = Number.isInteger(this.doc.startPage) ? this.doc.startPage : 0;
    this.popup = null; this.overlay = null; this.active = {}; this.history = [];
    this.log(t("sim3_restarted")); this.draw();
  }

  /* Tile tap / long press -> navigation (everything else is only named). */
  tapTile(path, long, nested) {
    if (nested) return this.nestedChooser(path);
    const it = mapAt(this.doc, path);
    if (!it) return;
    const scene = path.includes("/scenes/");
    const o = long ? it.long_press : it;
    if (!o || typeof o !== "object") return this.log(`${it.name || ""}: ${t(long ? "sim3_no_long" : "sim3_no_action")}`);
    const act = o.activity && (this.doc.activities || []).find((a) => a.id === o.activity);
    if ((scene || long) && act) {
      this.active[act.room] = act.id;
      if (act.page) return this.goto(act.page);
      return this.log(`🎬 ${act.name || act.id}`);
    }
    if (o.page) return this.goto(o.page, o.pageMode === "popup" ? "popup" : "page");
    if (o.closePopup === true && this.popup) return this.closePopup();
    this.log(`${it.name || ""}: ${t("sim3_not_executed")} (${hotkeySummary(o)})`);
  }

  /* A row's nested card: the builder draws a placeholder -> list its links. */
  nestedChooser(path) {
    const card = mapAt(this.doc, path) || {};
    const lk = { button_grid: "buttons", scene_grid: "scenes" }[card.type];
    const items = lk ? ((card.options || {})[lk] || []).map((x, k) => [`${path}/options/${lk}/${k}`, x]).filter(([, x]) => x && typeof x === "object") : [];
    if (!items.length) return this.log(`${card.type || "?"}: ${t("sim3_no_action")}`);
    const dlg = el("dialog", { class: "navmap-dialog" }, el("h3", { text: `${card.type} · ${t("sim3_nested")}` }));
    const done = () => { dlg.close(); dlg.remove(); };
    for (const [pth, x] of items) {
      dlg.append(el("div", { class: "row" }, el("strong", { text: x.name || pth.split("/").pop() }), el("span", { class: "spacer" }),
        el("button", { text: "👆", title: t("map_tap"), onclick: () => { done(); this.tapTile(pth, false); } }),
        el("button", { text: "✋", title: t("map_long_tap"), onclick: () => { done(); this.tapTile(pth, true); } })));
    }
    dlg.append(el("div", { class: "row" }, el("span", { class: "spacer" }), el("button", { text: t("cancel"), onclick: done })));
    document.body.append(dlg);
    dlg.showModal();
  }

  /* HA100 key: page hotkeys override global ones (MainActivity.mergeHotkeys). */
  pressKey(key, long) {
    const pages = this.pages();
    const page = this.popup ? pages[this.popup.page] : pages[this.cur];
    const g = long ? "longHotkeys" : "hotkeys";
    const merged = {};
    for (const hk of [...(this.doc[g] || []), ...((page && page[g]) || [])]) if (hk && hk.key) merged[hwKey(hk.key)] = hk;
    const hk = merged[key];
    const label = `${HW_LABEL[key] || key}${long ? " (" + t("map_long") + ")" : ""}`;
    const all = [...(this.doc.hotkeys || []), ...(this.doc.longHotkeys || []), ...pages.flatMap((p) => [...(p.hotkeys || []), ...(p.longHotkeys || [])])];
    if (!hk && long && key === "MAIN" && !all.some((h) => h && String(h.openOverlay || "").toLowerCase() === "settings")) return this.openOverlay("settings");
    if (!hk) {
      if (!long && this.popup && key === "BACK") return this.closePopup();
      if (!long && page && page.parent && key === hwKey(page.parentKey || "BACK")) return this.goto(page.parent);
      return this.log(`${label}: ${t("sim3_no_hotkey")}`);
    }
    const ov = String(hk.openOverlay || "").toLowerCase();
    if (ov) return this.openOverlay(ov);
    if (hk.openCurrentActivityRoom) {
      const act = (this.doc.activities || []).find((a) => a.id === this.active[hk.openCurrentActivityRoom]);
      return act && act.page ? this.goto(act.page) : this.log(`${label}: ${t("sim3_no_activity")}`);
    }
    if (hk.page && String(hk.pageMode || "").toLowerCase() === "popup") {
      const idx = this.pageIndex(hk.page);
      if (this.popup && this.popup.page === idx) return this.closePopup(); // same key closes it (1.2.8)
      return this.goto(hk.page, "popup");
    }
    if (hk.page) return this.goto(hk.page);
    this.log(`${label}: ${t("sim3_not_executed")} (${hotkeySummary(hk)})`);
  }

  keys() {
    const pad = el("div", { class: "sim3-keys" }, el("strong", { text: t("sim3_keys") }), el("div", { class: "muted", text: t("sim3_keys_hint") }));
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

  /* ---------- overlays (swipe down = Activities; long MAIN = Settings) ---------- */
  openOverlay(kind) { this.overlay = kind; this.log(kind === "activities" ? "👇 " + t("map_overlay_activities") : "⚙ " + t("map_overlay_settings")); this.drawOverlay(); }
  drawOverlay() {
    const box = this.overlayBox;
    if (!this.overlay) { box.hidden = true; return; }
    box.hidden = false;
    const head = el("div", { class: "row" }, el("strong", { text: this.overlay === "activities" ? t("map_overlay_activities") : t("map_overlay_settings") }),
      el("span", { class: "spacer" }), el("button", { text: "✕", onclick: () => { this.overlay = null; this.drawOverlay(); } }));
    if (this.overlay !== "activities") { box.replaceChildren(head, el("p", { class: "muted", text: t("sim3_settings_note") })); return; }
    box.replaceChildren(head, ...(this.doc.activities || []).map((a) => {
      const on = this.active[a.room] === a.id;
      return el("button", { class: "sim3-act" + (on ? " on" : ""), onclick: () => {
        if (on) { delete this.active[a.room]; this.log(`■ ${a.name || a.id}`); this.drawOverlay(); return; }
        this.active[a.room] = a.id; this.overlay = null;
        if (a.page) this.goto(a.page); else { this.log(`🎬 ${a.name || a.id}`); this.draw(); }
      } }, el("strong", { text: a.name || a.id }), el("span", { class: "muted", text: ` ${a.room || ""}` }));
    }));
  }
}
