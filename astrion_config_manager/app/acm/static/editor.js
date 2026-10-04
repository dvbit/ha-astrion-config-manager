/* Form editor for dashboard.json (spec RF3).
 *
 * - RF3.1  forms for pages, cards, hotkeys, IR devices, Activities, theme.
 *          Card fields come from card_schema.json, extracted from the
 *          upstream Kotlin renderers (CardConfig.string/bool/int/stringList).
 * - RF3.2  lossless round-trip: the editor only mutates the keys it edits;
 *          unknown cards/fields stay intact and are editable as raw JSON.
 * - RF2.3  every committed field (change event = blur or Enter) and every
 *          structural operation produces exactly one commit.
 * - RF4.4  validation issues (JSON pointers) are shown inline.
 */
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
const ptr = (...parts) => parts.map((p) => "/" + String(p).replaceAll("~", "~0").replaceAll("/", "~1")).join("");

/* Static option lists from the upstream sources. */
const POPUP_POSITIONS = ["center", "top", "bottom", "left", "right"];
const OPEN_MODES = ["page", "popup"];

/* Field specs: [key, kind, options]. Kinds map to input widgets below. */
const PAGE_FIELDS = [
  ["name", "text"], ["parent", "page"], ["parentKey", "hwkey"], ["linkedPage", "page"],
  ["linkedPageMode", "select", OPEN_MODES], ["openWhenEntity", "entity"], ["openWhenState", "text"],
  ["closeWhenState", "text"], ["openMode", "select", OPEN_MODES], ["popupWidth", "float"],
  ["popupHeight", "float"], ["popupPosition", "select", POPUP_POSITIONS], ["hiddenUnlessActivity", "text"],
];
const PAGE_OWN = new Set(["cards", "hotkeys", "longHotkeys", ...PAGE_FIELDS.map((f) => f[0])]);
const HOTKEY_FIELDS = [
  ["key", "hwkey"], ["page", "page"], ["service", "text"], ["entityId", "entity"], ["data", "json"],
  ["harmonyDevice", "text"], ["harmonyCommand", "text"], ["harmonyActivity", "text"], ["hub", "text"],
  ["irDevice", "irdev"], ["irCommand", "text"], ["track", "bool"],
];
const IR_FIELDS = [["id", "text"], ["name", "text"]];
const ACTIVITY_FIELDS = [
  ["id", "text"], ["name", "text"], ["room", "text"], ["icon", "text"], ["page", "page"],
  ["volumeDeviceId", "text"], ["volumeUpCommand", "text"], ["volumeDownCommand", "text"],
  ["muteCommand", "text"], ["devices", "json"],
];

class Editor {
  /* opts: {root, schema, hwKeys, commit(newDoc), copy(kind, payload), remotes()} */
  constructor(opts) {
    Object.assign(this, opts);
    this.sel = { kind: "page", p: 0 };
    this.doc = null;
    this.issues = [];
  }

  /* Called by the app after every load/commit. */
  setDoc(doc, validation) {
    this.doc = doc;
    this.issues = (validation && validation.issues) || [];
    this.render();
  }

  /* One commit per operation (RF2.3): mutate a clone, hand it to the app. */
  change(mutator) {
    const next = clone(this.doc);
    mutator(next);
    return this.commit(next);
  }

  /* ---------- issues (RF4.4) ---------- */
  issuesAt(path) {
    return this.issues.filter((i) => i.path === path || i.path.startsWith(path + "/"));
  }
  issueText(i) {
    return t("v_" + i.code, i.params);
  }

  /* ---------- generic widgets ---------- */
  pages() { return (this.doc && Array.isArray(this.doc.pages)) ? this.doc.pages : []; }

  /* Build one field bound to obj[key]; objPath is the JSON pointer of obj. */
  field(obj, key, kind, opts, objPath, setter) {
    const path = objPath + ptr(key);
    const has = Object.prototype.hasOwnProperty.call(obj, key);
    const val = has ? obj[key] : undefined;
    const set = (v) => setter(key, v);
    let input;
    const sel = (values, current) => {
      const s = el("select", {}, el("option", { value: "", text: t("none") }));
      for (const v of values) s.append(el("option", { value: v, text: v, selected: v === current }));
      if (current != null && current !== "" && !values.includes(current)) {
        s.append(el("option", { value: current, text: `${current} (${t("unknown_type")})`, selected: true }));
      }
      s.onchange = () => set(s.value === "" ? undefined : s.value);
      return s;
    };
    switch (kind) {
      case "bool": {
        const dflt = opts && opts.default;
        input = el("input", { type: "checkbox" });
        input.checked = has ? !!val : !!dflt;
        input.onchange = () => set(input.checked);
        break;
      }
      case "int":
      case "float":
        input = el("input", { type: "number", step: kind === "int" ? "1" : "any", value: has ? val : "",
          placeholder: opts && opts.default !== undefined ? String(opts.default) : "" });
        input.onchange = () => {
          if (input.value === "") return set(undefined);
          set(kind === "int" ? parseInt(input.value, 10) : parseFloat(input.value));
        };
        break;
      case "select": input = sel(opts, val); break;
      case "page": input = sel(this.pages().map((p) => p.name).filter(Boolean), val); break;
      case "hwkey": input = sel(this.hwKeys, val); break;
      case "irdev": input = sel((this.doc.irDevices || []).map((d) => d.id).filter(Boolean), val); break;
      case "lines":
        input = el("textarea", { rows: 3 });
        input.value = Array.isArray(val) ? val.join("\n") : "";
        input.onchange = () => {
          const lines = input.value.split("\n").map((s) => s.trim()).filter(Boolean);
          set(lines.length ? lines : undefined);
        };
        break;
      case "json":
        return this.jsonField(key, val, path, (v) => set(v), has);
      default: // text, entity
        input = el("input", { type: "text", value: has && val != null ? (typeof val === "string" ? val : JSON.stringify(val)) : "",
          list: kind === "entity" || /entit|entity_id|master/.test(key) ? "entity-list" : null,
          placeholder: opts && opts.default !== undefined ? String(opts.default) : "" });
        input.onchange = () => set(input.value === "" ? undefined : input.value);
    }
    return this.wrap(key, input, path);
  }

  /* JSON sub-editor: commits only when the text parses (RF4.1 invalid JSON). */
  jsonField(label, val, path, set, has = true) {
    const ta = el("textarea", { rows: 4 });
    ta.value = has && val !== undefined ? JSON.stringify(val, null, 2) : "";
    const box = this.wrap(label, ta, path);
    ta.onchange = () => {
      if (ta.value.trim() === "") return set(undefined);
      try { set(JSON.parse(ta.value)); } catch (e) {
        box.classList.add("invalid");
        box.append(el("div", { class: "msg", text: `${t("invalid_json")}: ${e.message}` }));
      }
    };
    return box;
  }

  wrap(label, input, path) {
    const issues = this.issuesAt(path);
    const box = el("div", { class: "field" + (issues.length ? " invalid" : ""), "data-path": path },
      el("label", { text: label }), input);
    for (const i of issues) box.append(el("div", { class: "msg", text: this.issueText(i) }));
    return box;
  }

  /* Setter factory: writes obj at JSON path, deleting key on undefined. */
  setterFor(getObj) {
    return (key, v) => this.change((d) => {
      const o = getObj(d);
      if (v === undefined) delete o[key]; else o[key] = v;
    });
  }

  /* Fields of `specs` plus "other fields" JSON for everything else (RF3.2). */
  form(obj, specs, objPath, getObj, ownKeys) {
    const set = this.setterFor(getObj);
    const grid = el("div", { class: "grid" });
    for (const [k, kind, opts] of specs) grid.append(this.field(obj, k, kind, opts, objPath, set));
    const own = ownKeys || new Set(specs.map((s) => s[0]));
    const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => !own.has(k)));
    const restBox = this.jsonField(t("unknown_fields"), rest, objPath, (v) => this.change((d) => {
      const o = getObj(d);
      for (const k of Object.keys(o)) if (!own.has(k)) delete o[k];
      Object.assign(o, v || {});
    }));
    return el("div", {}, grid, restBox);
  }

  /* Ordered list of objects with move/duplicate/remove (one version each). */
  listEditor(items, path, getArr, summary, formFor, newItem) {
    const box = el("div", {});
    items.forEach((item, idx) => {
      const ip = `${path}/${idx}`;
      const bad = this.issuesAt(ip).length;
      const body = el("div", { hidden: !bad });
      const head = el("div", { class: "list-item" },
        el("button", { class: "icon", text: "▸", onclick: () => { body.hidden = !body.hidden; } }),
        el("strong", { text: summary(item, idx) }), bad ? el("span", { class: "badge unreachable", text: String(bad) }) : null,
        el("span", { class: "spacer" }),
        this.structButtons(getArr, idx, items.length));
      body.append(formFor(item, ip, (d) => getArr(d)[idx]));
      box.append(el("div", { class: "card" }, head, body));
    });
    box.append(el("button", { text: "＋ " + t("add"), onclick: () => this.change((d) => getArr(d, true).push(newItem())) }));
    return box;
  }

  structButtons(getArr, idx, len) {
    const mv = (delta) => this.change((d) => {
      const a = getArr(d); const [x] = a.splice(idx, 1); a.splice(idx + delta, 0, x);
    });
    return el("span", { class: "row" },
      el("button", { class: "icon", title: t("move_up"), text: "↑", disabled: idx === 0, onclick: () => mv(-1) }),
      el("button", { class: "icon", title: t("move_down"), text: "↓", disabled: idx === len - 1, onclick: () => mv(1) }),
      el("button", { class: "icon", title: t("duplicate"), text: "⧉",
        onclick: () => this.change((d) => { const a = getArr(d); a.splice(idx + 1, 0, clone(a[idx])); }) }),
      el("button", { class: "icon danger", title: t("delete"), text: "✕",
        onclick: () => { if (confirm(t("confirm_delete"))) this.change((d) => getArr(d).splice(idx, 1)); } }));
  }

  /* ---------- rendering ---------- */
  render() {
    const root = this.root;
    root.replaceChildren();
    if (!this.doc || typeof this.doc !== "object" || Array.isArray(this.doc) || !Array.isArray(this.doc.pages)) {
      this.sel = { kind: "raw" }; // legacy array form or broken root: raw JSON only
    }
    root.append(this.renderIssues());
    root.append(el("div", { class: "layout" }, this.renderTree(), el("div", {}, this.renderPanel())));
  }

  renderIssues() {
    if (!this.issues.length) return el("div", { class: "card issues ok", text: "✓ " + t("no_issues") });
    const ul = el("ul", {});
    for (const i of this.issues) {
      ul.append(el("li", { text: `${i.path || "/"} — ${this.issueText(i)}`, onclick: () => this.reveal(i.path) }));
    }
    return el("div", { class: "card issues" }, el("strong", { text: `${t("issues")} (${this.issues.length})` }), ul);
  }

  /* Jump to the element an issue points to. */
  reveal(path) {
    const m = path.match(/^\/pages\/(\d+)(?:\/cards\/(\d+))?/);
    if (m) this.sel = m[2] !== undefined ? { kind: "card", p: +m[1], c: +m[2] } : { kind: "page", p: +m[1] };
    else {
      const g = path.split("/")[1];
      this.sel = ["hotkeys", "longHotkeys", "irDevices", "activities", "theme"].includes(g) ? { kind: "global", g } : { kind: "raw" };
    }
    this.render();
    const target = this.root.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (target) target.scrollIntoView({ block: "center" });
  }

  renderTree() {
    const tree = el("div", { class: "card tree" });
    const item = (label, sel, isSel, bad) => el("button", {
      class: "item" + (isSel ? " sel" : ""), onclick: () => { this.sel = sel; this.render(); },
    }, label, bad ? " ⚠" : "");
    const s = this.sel;
    if (Array.isArray(this.doc && this.doc.pages)) {
      tree.append(el("h3", { text: t("pages") }));
      this.doc.pages.forEach((p, pi) => {
        tree.append(item(`${pi + 1}. ${p.name || t("page")}`, { kind: "page", p: pi },
          s.kind === "page" && s.p === pi, this.issuesAt(`/pages/${pi}`).length));
        if (s.p === pi && (s.kind === "page" || s.kind === "card")) {
          const sub = el("div", { class: "sub" });
          (p.cards || []).forEach((c, ci) => sub.append(item(`${c.type || "?"} ${(c.options && (c.options.name || c.options.title)) || ""}`,
            { kind: "card", p: pi, c: ci }, s.kind === "card" && s.c === ci, this.issuesAt(`/pages/${pi}/cards/${ci}`).length)));
          tree.append(sub);
        }
      });
      tree.append(el("button", { text: "＋ " + t("add_page"),
        onclick: () => this.change((d) => d.pages.push({ name: `${t("page")} ${d.pages.length + 1}`, cards: [] })) }));
      tree.append(el("h3", { text: t("global") }));
      for (const [g, label] of [["hotkeys", "hotkeys"], ["longHotkeys", "long_hotkeys"], ["irDevices", "ir_devices"],
        ["activities", "activities"], ["theme", "theme"]]) {
        tree.append(item(t(label), { kind: "global", g }, s.kind === "global" && s.g === g, this.issuesAt("/" + g).length));
      }
    }
    tree.append(item(t("raw_json"), { kind: "raw" }, s.kind === "raw", 0));
    return tree;
  }

  renderPanel() {
    const s = this.sel;
    const pages = this.pages();
    if (s.kind === "page" && pages[s.p]) return this.renderPage(s.p);
    if (s.kind === "card" && pages[s.p] && (pages[s.p].cards || [])[s.c]) return this.renderCard(s.p, s.c);
    if (s.kind === "global") return this.renderGlobal(s.g);
    if (s.kind !== "raw" && pages.length) { this.sel = { kind: "page", p: 0 }; return this.renderPage(0); }
    return this.renderRaw("", this.doc, (v) => this.commit(v));
  }

  /* RF2.3: raw JSON editor applied as one single version. */
  renderRaw(path, value, apply) {
    const ta = el("textarea", { rows: 24 });
    ta.value = JSON.stringify(value, null, 2);
    const msg = el("div", { class: "msg" });
    const box = el("div", { class: "card field" }, el("h3", { text: t("raw_json") }), ta, msg,
      el("button", { class: "primary", text: t("apply"), onclick: () => {
        try { apply(JSON.parse(ta.value)); } catch (e) { box.classList.add("invalid"); msg.textContent = `${t("invalid_json")}: ${e.message}`; }
      } }));
    return box;
  }

  renderPage(pi) {
    const page = this.doc.pages[pi];
    const path = `/pages/${pi}`;
    const getPage = (d) => d.pages[pi];
    const panel = el("div", {});
    panel.append(el("div", { class: "card" },
      el("div", { class: "row" }, el("h2", { text: `${t("page")}: ${page.name || ""}` }), el("span", { class: "spacer" }),
        this.structButtons((d) => d.pages, pi, this.doc.pages.length),
        el("button", { text: t("copy_to"), onclick: () => this.copy("pages", { pages: [pi] }) })),
      this.form(page, PAGE_FIELDS, path, getPage, PAGE_OWN)));
    // Cards of the page
    const cards = page.cards || [];
    const cardBox = el("div", { class: "card" }, el("h3", { text: t("cards") }));
    cards.forEach((c, ci) => cardBox.append(el("div", { class: "list-item" },
      el("button", { class: "icon", text: "✎", onclick: () => { this.sel = { kind: "card", p: pi, c: ci }; this.render(); } }),
      el("strong", { text: c.type || "?" }), el("span", { class: "muted", text: (c.options && (c.options.name || c.options.title || c.options.entity_id)) || "" }),
      el("span", { class: "spacer" }), this.structButtons((d) => d.pages[pi].cards, ci, cards.length))));
    const typeSel = el("select", {}, ...Object.keys(this.schema).sort().map((k) => el("option", { value: k, text: k })));
    cardBox.append(el("div", { class: "row" }, typeSel, el("button", { text: "＋ " + t("add_card"),
      onclick: () => this.change((d) => { (d.pages[pi].cards = d.pages[pi].cards || []).push({ type: typeSel.value, options: {} }); }) })));
    panel.append(cardBox);
    // Page-level hotkeys
    for (const [g, label] of [["hotkeys", "hotkeys"], ["longHotkeys", "long_hotkeys"]]) {
      panel.append(el("div", { class: "card" }, el("h3", { text: t(label) }),
        this.hotkeyList(page[g] || [], `${path}/${g}`, (d, create) => {
          if (create && !d.pages[pi][g]) d.pages[pi][g] = [];
          return d.pages[pi][g];
        })));
    }
    return panel;
  }

  renderCard(pi, ci) {
    const card = this.doc.pages[pi].cards[ci];
    const path = `/pages/${pi}/cards/${ci}`;
    const spec = this.schema[card.type];
    const panel = el("div", { class: "card" });
    panel.append(el("div", { class: "row" },
      el("button", { text: "← " + (this.doc.pages[pi].name || t("page")), onclick: () => { this.sel = { kind: "page", p: pi }; this.render(); } }),
      el("h2", { text: card.type }), el("span", { class: "spacer" }),
      el("button", { text: t("copy_to"), onclick: () => this.copy("cards", { src_page: pi, cards: [ci] }) })));
    if (!spec) {
      panel.append(el("p", { class: "muted", text: t("unknown_card") }));
      panel.append(this.renderRaw(path, card, (v) => this.change((d) => { d.pages[pi].cards[ci] = v; })));
      return panel;
    }
    const opts = card.options || {};
    const kindMap = { string: "text", bool: "bool", int: "int", string_list: "lines", json: "json" };
    const specs = Object.entries(spec.fields).map(([k, f]) => [k, kindMap[f.kind], f]);
    panel.append(this.form(opts, specs, `${path}/options`, (d) => {
      const c = d.pages[pi].cards[ci];
      c.options = c.options || {};
      return c.options;
    }));
    // Keys beside type/options on the card object itself (RF3.2)
    const extra = Object.fromEntries(Object.entries(card).filter(([k]) => k !== "type" && k !== "options"));
    if (Object.keys(extra).length) {
      panel.append(this.jsonField(t("unknown_fields"), extra, path, (v) => this.change((d) => {
        const c = d.pages[pi].cards[ci];
        for (const k of Object.keys(c)) if (k !== "type" && k !== "options") delete c[k];
        Object.assign(c, v || {});
      })));
    }
    return panel;
  }

  hotkeyList(items, path, getArr) {
    return this.listEditor(items, path, getArr,
      (h) => `${h.key || "?"} → ${h.service || h.page || h.harmonyActivity || h.harmonyCommand || h.irCommand || ""}`,
      (h, ip, get) => this.form(h, HOTKEY_FIELDS, ip, get),
      () => ({ key: "MAIN" }));
  }

  renderGlobal(g) {
    const panel = el("div", { class: "card" });
    const arr = (key) => (d, create) => { if (create && !Array.isArray(d[key])) d[key] = []; return d[key]; };
    if (g === "hotkeys" || g === "longHotkeys") {
      panel.append(el("h2", { text: t(g === "hotkeys" ? "hotkeys" : "long_hotkeys") }),
        this.hotkeyList(this.doc[g] || [], "/" + g, arr(g)));
      panel.append(el("h3", { text: t("start_page") }),
        this.field(this.doc, "startPage", "select", this.pages().map((_, i) => i),
          "", this.setterFor((d) => d)));
      // startPage is numeric: patch the select to store ints.
      const s = panel.querySelector('[data-path="/startPage"] select');
      s.onchange = () => this.change((d) => { if (s.value === "") delete d.startPage; else d.startPage = parseInt(s.value, 10); });
      s.value = this.doc.startPage !== undefined ? String(this.doc.startPage) : "";
    } else if (g === "irDevices") {
      panel.append(el("h2", { text: t("ir_devices") }), this.listEditor(this.doc.irDevices || [], "/irDevices", arr("irDevices"),
        (d) => `${d.id || "?"} ${d.name ? "— " + d.name : ""}`,
        (dev, ip, get) => this.irForm(dev, ip, get),
        () => ({ id: `ir_${(this.doc.irDevices || []).length + 1}`, commands: { power: { freq: 38000, pattern: [9000, 4500] } } })));
    } else if (g === "activities") {
      panel.append(el("h2", { text: t("activities") }), this.listEditor(this.doc.activities || [], "/activities", arr("activities"),
        (a) => `${a.name || a.id || "?"} (${a.room || ""})`,
        (a, ip, get) => this.form(a, ACTIVITY_FIELDS, ip, get),
        () => ({ id: `activity_${(this.doc.activities || []).length + 1}`, room: "room", devices: [{ deviceId: "", source: "ir" }] })));
    } else if (g === "theme") {
      panel.append(el("h2", { text: t("theme") }),
        this.jsonField(t("theme"), this.doc.theme || {}, "/theme", (v) => this.change((d) => { if (v === undefined) delete d.theme; else d.theme = v; })));
    }
    return panel;
  }

  /* IR device: inline codes or ir-database reference (DashboardLoader.parseIrDevice). */
  irForm(dev, ip, get) {
    const own = new Set(["id", "name", "commands", "category", "brand", "model", "target"]);
    const box = this.form(dev, IR_FIELDS, ip, get, own);
    const set = this.setterFor(get);
    const inline = Object.prototype.hasOwnProperty.call(dev, "commands");
    const mode = el("select", {},
      el("option", { value: "inline", text: t("inline_codes"), selected: inline }),
      el("option", { value: "db", text: t("db_ref"), selected: !inline }));
    mode.onchange = () => this.change((d) => {
      const o = get(d);
      if (mode.value === "inline") { delete o.category; delete o.brand; delete o.model; o.commands = o.commands || {}; }
      else { delete o.commands; o.category = o.category || ""; o.brand = o.brand || ""; o.model = o.model || ""; }
    });
    const grid = el("div", { class: "grid" }, this.wrap("source", mode, ip));
    if (inline) box.prepend(this.jsonField("commands", dev.commands, `${ip}/commands`, (v) => set("commands", v || {})));
    else for (const k of ["category", "brand", "model"]) grid.append(this.field(dev, k, "text", null, ip, set));
    const tgt = dev.target && typeof dev.target === "object" ? dev.target.extender : "";
    const tsel = el("select", {}, el("option", { value: "local", text: t("local") }),
      el("option", { value: "extender", text: t("extender"), selected: !!tgt }));
    const tid = el("input", { type: "text", value: tgt || "", placeholder: "extender id", hidden: !tgt });
    const apply = () => set("target", tsel.value === "local" ? undefined : { extender: tid.value });
    tsel.onchange = () => { tid.hidden = tsel.value === "local"; if (tsel.value === "local") apply(); };
    tid.onchange = apply;
    grid.append(this.wrap(t("target"), el("div", { class: "row" }, tsel, tid), `${ip}/target`));
    box.prepend(grid);
    return box;
  }
}
