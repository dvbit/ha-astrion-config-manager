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
 * - RF7.4  icon fields get a thumbnail + picker (library and remote icons);
 *          JSON sub-editors can insert an icon path at the cursor.
 * - RF7.5  form for the haDevices entity catalog.
 * - RF8.6  "hub" fields and IR extender targets are dropdowns of the hubs /
 *          extenders read from the remote; unknown hubs are warnings.
 * - RF3.6  list options (buttons, scenes, apps, monitor entities, speakers,
 *          picture elements) are item forms; row.cards nests full card forms.
 * - RF9    apple_tv_remote: "control via" Apple TV (direct, 1.2.0) or Harmony.
 * - RF3.5  fixed-value fields are dropdowns and colour fields have a palette
 *          (field_hints.json, from the upstream builder and renderers);
 *          the theme is a form of colours; JSON editors can insert a colour.
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
/* haDevices catalog types (remote's devices.html "Add device" form). */
const HA_DEVICE_DOMAINS = { light: ["light"], switch: ["switch"], cover: ["cover"], climate: ["climate"],
  media_player: ["media_player"], camera: ["camera"], fan: ["fan"], vacuum: ["vacuum"], weather: ["weather"],
  select: ["select", "input_select"] };
const ICON_PREFIX = "/sdcard/astrion/icons/";
/* Icon file name from a card value, or null (same rule as backend icons.icon_ref). */
const iconName = (v) => { const m = typeof v === "string" && v.match(/(?:^|\/)astrion\/icons\/([A-Za-z0-9._-]+)$/); return m ? m[1] : null; };
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
    this.warnings = [];
  }

  /* Called by the app after every load/commit. */
  setDoc(doc, validation) {
    this.doc = doc;
    this.issues = (validation && validation.issues) || [];
    this.warnings = (validation && validation.warnings) || [];
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
  warningsAt(path) {
    return this.warnings.filter((i) => i.path === path || i.path.startsWith(path + "/"));
  }
  issueText(i) {
    return t("v_" + i.code, i.params);
  }

  /* ---------- generic widgets ---------- */
  pages() { return (this.doc && Array.isArray(this.doc.pages)) ? this.doc.pages : []; }

  /* Build one field bound to obj[key]; objPath is the JSON pointer of obj. */
  field(obj, key, kind, opts, objPath, setter, getObj) {
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
      case "enum": return this.wrap(key, this.enumInput(opts, val, has, set), path);
      case "items": return this.itemsField(key, val, path, opts, getObj);
      case "cards": return this.cardsField(key, val, path, getObj);
      case "multi": return this.wrap(key, this.multiInput(opts, val, has, set), path);
      case "values": {
        // RF3.6 state_value: one value (string) or several (list), one per line
        input = el("textarea", { rows: 2, placeholder: t("one_per_line") });
        input.value = Array.isArray(val) ? val.join("\n") : (has && val != null ? String(val) : "");
        input.onchange = () => {
          const v = input.value.split("\n").map((x) => x.trim()).filter(Boolean);
          set(v.length === 0 ? undefined : v.length === 1 ? v[0] : v);
        };
        break;
      }
      case "border": return this.wrap(key, this.borderInput(val, has, set), path);
      case "pagemode": input = sel(["page", "popup"], val); break;
      case "activity": input = sel((this.doc.activities || []).map((a) => a.id).filter(Boolean), val); break;
      case "appletv": {
        const tvs = (this.remote().apple_tvs || []);
        const s2 = el("select", {}, el("option", { value: "", text: t("none") }),
          ...tvs.map((tv) => el("option", { value: tv.entityId, text: `${tv.name} (${tv.entityId})`, selected: tv.entityId === val })));
        if (val && !tvs.some((tv) => tv.entityId === val)) s2.append(el("option", { value: val, text: `${val} ⚠`, selected: true }));
        s2.onchange = () => set(s2.value === "" ? undefined : s2.value);
        return this.wrap(key, s2, path);
      }
      case "color": return this.wrap(key, this.colorInput(val, has, set, opts && opts.default), path);
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
        if (key === "hub") {
          // RF8.6: hub by localId (empty = first hub, as on the remote)
          const hubs = (this.remote().harmony_hubs || []);
          const hs = el("select", {}, el("option", { value: "", text: t("first_hub") }),
            ...hubs.map((h) => el("option", { value: h.localId, text: `${h.name || h.localId} (${h.ip})`, selected: h.localId === val })));
          if (val && !hubs.some((h) => h.localId === val)) hs.append(el("option", { value: val, text: `${val} ⚠`, selected: true }));
          hs.onchange = () => set(hs.value === "" ? undefined : hs.value);
          return this.wrap(key, hs, path);
        }
        if (key === "icon" || key.endsWith("_icon")) {
          // RF7.4: thumbnail + picker for custom icons
          const row = el("div", { class: "row icon-row" }, this.thumb(val), input,
            el("button", { class: "icon", text: "🖼", title: t("choose_icon"), onclick: () => this.pickIcon((name) => set(ICON_PREFIX + name)) }));
          return this.wrap(key, row, path);
        }
    }
    return this.wrap(key, input, path);
  }

  /* RF3.5: dropdown of the documented values; "" = key absent (remote default).
   * hint: {values, labels?, default, presets?}; presets allow any other number. */
  enumInput(hint, val, has, set) {
    const s = el("select", {}, el("option", { value: "", text: t("default_value", { v: hint.default }) }));
    hint.values.forEach((v, i) => s.append(el("option", { value: JSON.stringify(v), text: hint.labels ? `${hint.labels[i]} (${v})` : String(v), selected: has && v === val })));
    if (has && !hint.values.includes(val)) {
      s.append(el("option", { value: JSON.stringify(val), text: `${val}${hint.presets ? "" : " ⚠"}`, selected: true }));
    }
    s.onchange = () => set(s.value === "" ? undefined : JSON.parse(s.value));
    if (!hint.presets) return s;
    // presets: a free number is also valid
    const num = el("input", { type: "number", step: "any", value: has ? val : "", placeholder: t("other_value") });
    num.onchange = () => set(num.value === "" ? undefined : parseFloat(num.value));
    return el("div", { class: "row" }, s, num);
  }

  /* RF3.5: colour palette + hex text. The remote reads #RRGGBB or #AARRGGBB
   * (ui/Theme.kt parseHexColor): the palette edits RGB and keeps any alpha. */
  colorInput(val, has, set, dflt) {
    // dflt: value the remote uses when the key is absent (theme defaults):
    // shown in the swatch and as placeholder, so an unset key is not "black".
    const hex = (typeof val === "string" ? val : (has ? "" : dflt || "")).replace(/^#/, "");
    const rgb = /^[0-9a-f]{8}$/i.test(hex) ? hex.slice(2) : (/^[0-9a-f]{6}$/i.test(hex) ? hex : "000000");
    const pick = el("input", { type: "color", value: "#" + rgb.toLowerCase(), class: "swatch" });
    const txt = el("input", { type: "text", value: has && val != null ? String(val) : "",
      placeholder: dflt ? `${dflt} (${t("default_short")})` : "#RRGGBB / #AARRGGBB", class: "hex" });
    pick.onchange = () => {
      const alpha = /^[0-9a-f]{8}$/i.test(hex) ? hex.slice(0, 2) : "";
      set("#" + (alpha + pick.value.slice(1)).toUpperCase());
    };
    txt.onchange = () => set(txt.value.trim() === "" ? undefined : txt.value.trim());
    const clear = el("button", { class: "icon", text: "✕", title: t("delete"), onclick: () => set(undefined), disabled: !has });
    return el("div", { class: "row color-row" }, pick, txt, clear);
  }

  /* RF3.6: ordered list of objects edited with item forms (one version per change). */
  itemsField(key, val, path, specs, getObj) {
    const items = Array.isArray(val) ? val : [];
    const getArr = (d, create) => {
      const o = getObj(d);
      if (create && !Array.isArray(o[key])) o[key] = [];
      return o[key];
    };
    const summary = (it) => (it && typeof it === "object")
      ? [it.name, it.entity_id, it.service, it.app, it.activity, it.page, it.irCommand, it.harmonyCommand].filter(Boolean).slice(0, 2).join(" · ") || "…"
      : String(it);
    const keyField = specs[0][0];
    const list = this.listEditor(items, `${path}`, getArr, summary,
      (it, ip, get) => {
        if (it && typeof it === "object") return this.form(it, specs, ip, get, new Set(specs.map((x) => x[0])), true);
        // A bare string is ignored by the remote (it reads objects): offer a one-click fix
        const idx = +ip.split("/").pop();
        return el("div", {}, this.jsonField(key, it, ip, (v) => this.change((d) => { getArr(d)[idx] = v; })),
          typeof it === "string" ? el("button", { text: `${t("convert_item")} {"${keyField}": "${it}"}`,
            onclick: () => this.change((d) => { getArr(d)[idx] = { [keyField]: it }; }) }) : null);
      },
      () => ({}), specs.length <= 3);
    return el("div", { class: "field items", "data-path": path }, el("label", { text: `${key} (${items.length})` }), list);
  }

  /* RF3.6: row.cards - nested cards with their full forms. */
  cardsField(key, val, path, getObj) {
    const items = Array.isArray(val) ? val : [];
    const getArr = (d, create) => {
      const o = getObj(d);
      if (create && !Array.isArray(o[key])) o[key] = [];
      return o[key];
    };
    const typeSel = el("select", {}, ...Object.keys(this.schema).filter((k) => k !== "row").sort().map((k) => el("option", { value: k, text: k })));
    const list = this.listEditor(items, path, getArr,
      (c) => `${c.type || "?"} ${(c.options && (c.options.name || c.options.title || c.options.entity_id)) || ""}`,
      (c, ip, get) => this.cardBody(c, ip, get),
      () => ({ type: typeSel.value, options: {} }));
    return el("div", { class: "field items", "data-path": path }, el("label", { text: `${key} (${items.length})` }),
      el("div", { class: "row" }, el("span", { class: "muted", text: t("card_type_new") }), typeSel), list);
  }

  /* apple_tv_remote buttons: several values from a fixed set (checkboxes). */
  multiInput(hint, val, has, set) {
    const cur = has && Array.isArray(val) ? val : null;
    const box = el("div", { class: "row multi" });
    for (const v of hint.values) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = (cur || hint.default).includes(v);
      cb.onchange = () => {
        const next = hint.values.filter((x) => (x === v ? cb.checked : (cur || hint.default).includes(x)));
        set(next);
      };
      box.append(el("label", { class: "row" }, cb, v));
    }
    box.append(el("button", { class: "icon", text: t("default_short"), title: hint.default.join(", "), disabled: !has, onclick: () => set(undefined) }));
    return box;
  }

  /* active_border: true = theme accent, or a hex colour (ButtonGridCard). */
  borderInput(val, has, set) {
    const mode = !has || val === false ? "" : val === true ? "accent" : "color";
    const s2 = el("select", {}, el("option", { value: "", text: t("none") }),
      el("option", { value: "accent", text: t("border_accent"), selected: mode === "accent" }),
      el("option", { value: "color", text: t("border_color"), selected: mode === "color" }));
    s2.onchange = () => set(s2.value === "" ? undefined : s2.value === "accent" ? true : "#6EA8FE");
    const box = el("div", { class: "row" }, s2);
    if (mode === "color") box.append(this.colorInput(val, true, set));
    return box;
  }

  /* Thumbnail of a custom icon value (empty when not an icon path). */
  thumb(val) {
    const name = iconName(val);
    return name ? iconImg(this.rid, name, "thumb") : el("span", { class: "thumb" });
  }

  /* JSON sub-editor: commits only when the text parses (RF4.1 invalid JSON). */
  jsonField(label, val, path, set, has = true) {
    const ta = el("textarea", { rows: 4 });
    ta.value = has && val !== undefined ? JSON.stringify(val, null, 2) : "";
    const box = this.wrap(label, ta, path);
    // RF7.4: insert an icon path at the cursor (buttons/scenes/elements arrays)
    // mousedown is cancelled so the textarea keeps focus (no premature commit);
    // the edited text is committed as one version once the icon is chosen.
    const ins = el("button", { class: "icon", text: "🖼 " + t("insert_icon"), onclick: () => {
      const at = ta.selectionStart || 0, end = ta.selectionEnd || at;
      this.pickIcon((name) => {
        const text = ta.value.slice(0, at) + ICON_PREFIX + name + ta.value.slice(end);
        try { set(JSON.parse(text)); } catch (e) { ta.value = text; ta.focus(); } // invalid JSON: leave it to the user
      });
    } });
    ins.addEventListener("mousedown", (e) => e.preventDefault());
    // RF3.5: insert a colour (e.g. scene "color" / "active_color") at the cursor
    const palette = el("input", { type: "color", class: "hidden-color" });
    let at = 0, end = 0;
    const col = el("button", { class: "icon", text: "🎨 " + t("insert_color"), onclick: () => {
      at = ta.selectionStart || 0; end = ta.selectionEnd || at; palette.click();
    } });
    col.addEventListener("mousedown", (e) => e.preventDefault());
    palette.onchange = () => {
      const text = ta.value.slice(0, at) + palette.value.toUpperCase() + ta.value.slice(end);
      try { set(JSON.parse(text)); } catch (e) { ta.value = text; ta.focus(); }
    };
    box.querySelector("label").append(" ", ins, " ", col, palette);
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
    for (const w of this.warningsAt(path)) { box.classList.add("warn"); box.append(el("div", { class: "msg warn", text: "⚠ " + this.issueText(w) })); }
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
  form(obj, specs, objPath, getObj, ownKeys, hideEmptyRest) {
    const wide = [];
    const set = this.setterFor(getObj);
    const grid = el("div", { class: "grid" });
    for (const [k, kind, opts] of specs) {
      const f = this.field(obj, k, kind, opts, objPath, set, getObj);
      // list editors take the full width below the grid of simple fields
      if (kind === "items" || kind === "cards") wide.push(f); else grid.append(f);
    }
    const own = ownKeys || new Set(specs.map((s) => s[0]));
    const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => !own.has(k)));
    const restBox = this.jsonField(t("unknown_fields"), rest, objPath, (v) => this.change((d) => {
      const o = getObj(d);
      for (const k of Object.keys(o)) if (!own.has(k)) delete o[k];
      Object.assign(o, v || {});
    }));
    // list items: no empty "Other fields" box (keeps compact rows compact)
    if (hideEmptyRest && !Object.keys(rest).length) return el("div", {}, grid, ...wide);
    return el("div", {}, grid, ...wide, restBox);
  }

  /* Ordered list of objects with move/duplicate/remove (one version each). */
  /* Ordered list editor. Expanded items are remembered in this.open (by JSON
   * path) so a commit - which re-renders the editor - does not collapse the
   * item being edited; new items open automatically; compact lists (few
   * fields, e.g. monitor entities) are always open. */
  listEditor(items, path, getArr, summary, formFor, newItem, compact) {
    const box = el("div", {});
    this.open = this.open || new Set();
    items.forEach((item, idx) => {
      const ip = `${path}/${idx}`;
      const bad = this.issuesAt(ip).length;
      const isOpen = compact || bad || this.open.has(ip);
      const body = el("div", { hidden: !isOpen });
      const head = el("div", { class: "list-item" },
        compact ? null : el("button", { class: "icon", text: isOpen ? "▾" : "▸", onclick: (e) => {
          body.hidden = !body.hidden;
          e.target.textContent = body.hidden ? "▸" : "▾";
          if (body.hidden) this.open.delete(ip); else this.open.add(ip);
        } }),
        el("strong", { text: summary(item, idx) }), bad ? el("span", { class: "badge unreachable", text: String(bad) }) : null,
        el("span", { class: "spacer" }),
        this.structButtons(getArr, idx, items.length));
      body.append(formFor(item, ip, (d) => getArr(d)[idx]));
      box.append(el("div", { class: "card" }, head, body));
    });
    box.append(el("button", { text: "＋ " + t("add"), onclick: () => {
      this.open.add(`${path}/${items.length}`); // open the new item
      this.change((d) => getArr(d, true).push(newItem()));
    } }));
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
    const warn = this.warnings.length ? el("div", { class: "card issues warn" }, el("strong", { text: `⚠ ${t("warnings")} (${this.warnings.length})` }),
      el("ul", {}, ...this.warnings.map((w) => el("li", { text: `${w.path} — ${this.issueText(w)}`, onclick: () => this.reveal(w.path) })))) : null;
    if (!this.issues.length) return el("div", {}, el("div", { class: "card issues ok", text: "✓ " + t("no_issues") }), warn);
    const ul = el("ul", {});
    for (const i of this.issues) {
      ul.append(el("li", { text: `${i.path || "/"} — ${this.issueText(i)}`, onclick: () => this.reveal(i.path) }));
    }
    return el("div", {}, el("div", { class: "card issues" }, el("strong", { text: `${t("issues")} (${this.issues.length})` }), ul), warn);
  }

  /* Jump to the element an issue points to. */
  reveal(path) {
    const m = path.match(/^\/pages\/(\d+)(?:\/cards\/(\d+))?/);
    if (m) this.sel = m[2] !== undefined ? { kind: "card", p: +m[1], c: +m[2] } : { kind: "page", p: +m[1] };
    else {
      const g = path.split("/")[1];
      this.sel = ["hotkeys", "longHotkeys", "irDevices", "haDevices", "activities", "theme"].includes(g) ? { kind: "global", g } : { kind: "raw" };
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
        ["haDevices", "ha_devices"], ["activities", "activities"], ["theme", "theme"]]) {
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
    panel.append(this.cardBody(card, path, (d) => d.pages[pi].cards[ci]));
    return panel;
  }

  /* Form of one card (top-level or nested in a row); getCard(d) -> card object. */
  cardBody(card, path, getCard) {
    const spec = this.schema[card.type];
    const box = el("div", {});
    if (!spec) {
      box.append(el("p", { class: "muted", text: t("unknown_card") }),
        this.jsonField(t("raw_json"), card, path, (v) => this.change((d) => { const c = getCard(d); for (const k of Object.keys(c)) delete c[k]; Object.assign(c, v || {}); })));
      return box;
    }
    const opts = card.options || {};
    const kindMap = { string: "text", bool: "bool", int: "int", float: "float", string_list: "lines", json: "json" };
    const hints = this.hints || { enums: {}, colors: {}, items: {}, multi: {} };
    const enums = hints.enums[card.type] || {};
    const colors = new Set(hints.colors[card.type] || []);
    const multi = (hints.multi || {})[card.type] || {};
    const items = hints.items || {};
    let entries = Object.entries(spec.fields);
    const getOpts = (d) => { const c = getCard(d); c.options = c.options || {}; return c.options; };
    if (card.type === "apple_tv_remote") {
      // RF9: "Control via" like the native builder; appleTv wins when both are set
      const mode = opts.appleTv ? "direct" : "harmony";
      const via = el("select", {}, el("option", { value: "direct", text: t("ctl_direct"), selected: mode === "direct" }),
        el("option", { value: "harmony", text: t("ctl_harmony"), selected: mode === "harmony" }));
      via.onchange = () => this.change((d) => {
        const o = getOpts(d);
        if (via.value === "direct") { delete o.deviceId; delete o.hub; o.appleTv = ((this.remote().apple_tvs || [])[0] || {}).entityId || ""; }
        else { delete o.appleTv; o.deviceId = o.deviceId || ""; }
      });
      box.append(this.wrap(t("control_via"), via, `${path}/options/appleTv`));
      entries = entries.filter(([k]) => (mode === "direct" ? k !== "deviceId" && k !== "hub" : k !== "appleTv"));
    }
    const specs = entries.map(([k, f]) => {
      const it = items[`${card.type}.${k}`];
      if (it === "cards") return [k, "cards", f];
      if (it) return [k, "items", it];
      if (multi[k]) return [k, "multi", multi[k]];
      if (k === "appleTv") return [k, "appletv", f];
      if (enums[k]) return [k, "enum", enums[k]];
      if (colors.has(k)) return [k, "color", f];
      return [k, kindMap[f.kind], f];
    });
    box.append(this.form(opts, specs, `${path}/options`, getOpts));
    // Keys beside type/options on the card object itself (RF3.2)
    const extra = Object.fromEntries(Object.entries(card).filter(([k]) => k !== "type" && k !== "options"));
    if (Object.keys(extra).length) {
      box.append(this.jsonField(t("unknown_fields"), extra, path, (v) => this.change((d) => {
        const c = getCard(d);
        for (const k of Object.keys(c)) if (k !== "type" && k !== "options") delete c[k];
        Object.assign(c, v || {});
      })));
    }
    return box;
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
    } else if (g === "haDevices") {
      // RF7.5: named entity catalog, used by the remote's web builder pickers
      panel.append(el("h2", { text: t("ha_devices") }), el("p", { class: "muted", text: t("ha_devices_hint") }),
        this.listEditor(this.doc.haDevices || [], "/haDevices", arr("haDevices"),
          (d) => `${d.name || "?"} — ${d.entityId || ""}`,
          (dev, ip, get) => this.haDeviceForm(dev, ip, get),
          () => ({ id: `ha_device_${(this.doc.haDevices || []).length + 1}`, domain: "light", entityId: "", name: "" })));
    } else if (g === "activities") {
      panel.append(el("h2", { text: t("activities") }), this.listEditor(this.doc.activities || [], "/activities", arr("activities"),
        (a) => `${a.name || a.id || "?"} (${a.room || ""})`,
        (a, ip, get) => this.form(a, ACTIVITY_FIELDS, ip, get),
        () => ({ id: `activity_${(this.doc.activities || []).length + 1}`, room: "room", devices: [{ deviceId: "", source: "ir" }] })));
    } else if (g === "theme") {
      // RF3.5: ThemeConfig colours (config/AppConfig.kt) with palettes
      const th = this.doc.theme || {};
      const defaults = (this.hints && this.hints.theme) || {};
      panel.append(el("h2", { text: t("theme") }), el("p", { class: "muted", text: t("theme_hint") }),
        this.form(th, Object.entries(defaults).map(([k, dv]) => [k, "color", { default: dv }]), "/theme", (d) => { if (!d.theme || typeof d.theme !== "object") d.theme = {}; return d.theme; }));
    }
    return panel;
  }

  /* RF7.5: catalog entry; the entity list is filtered by the chosen type. */
  haDeviceForm(dev, ip, get) {
    const own = new Set(["id", "name", "domain", "entityId"]);
    const box = this.form(dev, [["name", "text"], ["id", "text"], ["domain", "select", Object.keys(HA_DEVICE_DOMAINS)]], ip, get, own);
    const doms = HA_DEVICE_DOMAINS[dev.domain] || [];
    const ents = (this.entities() || []).filter((e) => doms.includes(e.split(".")[0]));
    const sel = el("select", {}, el("option", { value: "", text: t("choose") }),
      ...ents.map((e) => el("option", { value: e, text: e, selected: e === dev.entityId })));
    if (dev.entityId && !ents.includes(dev.entityId)) sel.append(el("option", { value: dev.entityId, text: `${dev.entityId} ⚠`, selected: true }));
    sel.onchange = () => this.change((d) => {
      const o = get(d);
      o.entityId = sel.value;
      if (!o.name) o.name = sel.value; // same convenience as the remote's form
    });
    box.querySelector(".grid").append(this.wrap("entityId", sel, `${ip}/entityId`));
    return box;
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
    // RF8.6: local (remote's own blaster) or one of the remote's extenders
    const tgt = dev.target && typeof dev.target === "object" ? dev.target.extender : "";
    const exts = this.remote().extenders || [];
    const tsel = el("select", {}, el("option", { value: "", text: t("local") }),
      ...exts.map((x) => el("option", { value: x.localId, text: `${t("extender")}: ${x.name || x.localId} (${x.host})`, selected: x.localId === tgt })));
    if (tgt && !exts.some((x) => x.localId === tgt)) tsel.append(el("option", { value: tgt, text: `${t("extender")}: ${tgt} ⚠`, selected: true }));
    tsel.onchange = () => set("target", tsel.value === "" ? undefined : { extender: tsel.value });
    grid.append(this.wrap(t("target"), tsel, `${ip}/target`));
    box.prepend(grid);
    return box;
  }
}
