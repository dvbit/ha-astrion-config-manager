/* Astrion Config Manager panel (spec RF1, RF2, RF5; editor in editor.js,
 * simulator in simulator.js - RF6).
 * Views: remote list / archive (RF1.4, RF5.5) and remote detail with tabs
 * Editor (RF3), History (RF2.7, RF2.11-2.13) and Sync (RF5). */
"use strict";

const S = {
  view: "list",        // "list" | "archive" | "remote"
  remotes: [],
  drift: {},           // remote id -> drift status (RF5.2)
  driftChanges: {},    // remote id -> {paths, count, settings_only} (RF10.12)
  ignored: new Set(),  // drift dismissed until next check (RF5.3 "ignore")
  rid: null, tab: "editor", remote: null, doc: null, validation: null,
  onlyNamed: false,
  schema: {}, hwKeys: [],
  entities: [],        // HA entity ids (autocomplete, catalog form)
};

/* Icon <img>: library first, then the remote's own copy (RF7). */
function iconImg(rid, name, cls) {
  const img = el("img", { class: cls || "", alt: name, title: name, src: `api/icons/${encodeURIComponent(name)}` });
  img.onerror = () => {
    if (rid && !img.dataset.fallback) { img.dataset.fallback = "1"; img.src = `api/remotes/${rid}/icons/${encodeURIComponent(name)}`; }
    else img.replaceWith(el("span", { class: (cls || "") + " missing", text: "?", title: name }));
  };
  return img;
}

/* Upload one or more files to the library (RF7.1). */
async function uploadIcons(files) {
  const form = new FormData();
  for (const f of files) form.append("file", f, f.name);
  const resp = await fetch("api/icons", { method: "POST", body: form });
  const data = await resp.json();
  if (!resp.ok) throw Object.assign(new Error(data.error), { data });
  toast(`${t("icons_added")}: ${data.added.join(", ")}`);
  return data.added;
}

/* Icon picker: library + icons already on the remote (RF7.4). */
async function openIconPicker(rid, onPick) {
  const dlg = el("dialog", {});
  const grid = el("div", { class: "icon-grid" });
  const fill = async () => {
    const lst = rid ? await api("GET", `api/remotes/${rid}/icons`) : { library: (await api("GET", "api/icons")).map((i) => i.name), device: [] };
    const lib = new Set(lst.library);
    const all = [...new Set([...lst.library, ...(lst.device || [])])].sort();
    grid.replaceChildren(...(all.length ? all.map((n) => el("button", { class: "icon-cell", onclick: () => { dlg.close(); dlg.remove(); onPick(n); } },
      iconImg(rid, n, "big"), el("span", { text: n }), el("span", { class: "muted", text: lib.has(n) ? t("in_library") : t("on_remote_only") })))
      : [el("p", { class: "muted", text: t("empty_list") })]));
  };
  const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true });
  file.onchange = guard(async () => { await uploadIcons(file.files); await fill(); });
  dlg.append(el("h2", { text: t("choose_icon") }), el("div", { class: "row" }, file), grid,
    el("div", { class: "row" }, el("span", { class: "spacer" }), el("button", { text: t("cancel"), onclick: () => { dlg.close(); dlg.remove(); } })));
  document.body.append(dlg);
  dlg.showModal();
  await guard(fill)();
}

/* Entity autocomplete + catalog names (RF7.5). */
function refreshEntityList() {
  const cat = (S.doc && Array.isArray(S.doc.haDevices)) ? S.doc.haDevices : [];
  const named = new Map(cat.filter((d) => d && d.entityId).map((d) => [d.entityId, d.name]));
  // RF9.2: paired Apple TVs are entities of the remote itself
  for (const tv of (S.remote && S.remote.apple_tvs) || []) if (!named.has(tv.entityId)) named.set(tv.entityId, tv.name);
  // RF16.2: built-in weather published by the remote itself (1.3.2-beta)
  const w = S.doc && S.doc.weather;
  if (w && typeof w.latitude === "number" && typeof w.longitude === "number") named.set("weather.astrion", `${t("weather_builtin")}${w.name ? " · " + w.name : ""}`);
  document.getElementById("entity-list").replaceChildren(
    ...[...named].map(([e, n]) => el("option", { value: e, label: `★ ${n}` })),
    ...S.entities.filter((e) => !named.has(e)).map((e) => el("option", { value: e })));
}
const main = document.getElementById("main");

/* ---------- API ---------- */
async function api(method, url, body) {
  const resp = await fetch(url, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await resp.json(); } catch (e) { /* empty body */ }
  if (!resp.ok) {
    const err = new Error((data && data.error) || `HTTP ${resp.status}`);
    err.status = resp.status; err.data = data || {};
    throw err;
  }
  return data;
}

function toast(msg, isErr) {
  const tEl = document.getElementById("toast");
  tEl.textContent = msg; tEl.className = "toast" + (isErr ? " err" : ""); tEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { tEl.hidden = true; }, isErr ? 6000 : 3000);
}

/* Error codes from the backend are translated (RNF3). RF2.10: on a head
 * conflict the view realigns and the user is informed. */
async function handleError(err) {
  if (err.data && err.data.error === "head_changed") {
    toast(t("realigned"), true);
    await loadRemote();
    return;
  }
  const code = (err.data && err.data.error) || "internal";
  toast(t("err_" + code) + (err.data && err.data.detail ? ` (${err.data.detail})` : ""), true);
  if (err.data && err.data.validation) { S.validation = err.data.validation; render(); }
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { await handleError(e); } };

/* ---------- loading ---------- */
async function loadList(archived) {
  S.remotes = await api("GET", "api/remotes" + (archived ? "?archived=1" : ""));
  render();
  if (!archived) await checkDriftAll();
}

/* RF5.2: drift check at panel opening for every non-archived remote. */
async function checkDriftAll() {
  for (const r of S.remotes) S.drift[r.id] = "unknown";
  render();
  const res = await api("GET", "api/drift");
  for (const d of res) { S.drift[d.id] = d.status; S.driftChanges[d.id] = d.changes; S.ignored.delete(d.id); }
  render();
}

async function loadRemote() {
  const data = await api("GET", `api/remotes/${S.rid}/state`);
  applyResult(data);
}

function applyResult(data) {
  S.remote = data.remote;
  S.doc = data.state;
  S.validation = data.validation;
  refreshEntityList();
  render();
  // RF16.4: unsynced state decides whether the builder link asks push/discard first
  refreshNativeUnsynced().then(() => { if (S.remote && S.remote.native_builder) render(); });
}

/* Commit from the editor (RF2.3). */
async function commit(newDoc) {
  // RF16.4: in "Edit with the remote's builder" mode the add-on is read-only (backup)
  if (S.remote && S.remote.native_builder) { toast(t("nb_readonly"), true); render(); return; }
  try {
    const res = await api("POST", `api/remotes/${S.rid}/commit`, { head: S.remote.head, state: newDoc });
    applyResult(res);
    if (res.version) toast(`${t("saved_version")} v${res.version.id}`);
  } catch (e) { await handleError(e); }
}

/* ---------- views ---------- */
function render() {
  document.getElementById("title").textContent = t("app_title");
  if (S.view === "remote") return renderRemote();
  return renderList();
}

function statusBadge(id) {
  const st = S.drift[id] || "unknown";
  return el("span", { class: `badge ${st}`, text: t("st_" + st) });
}

/* RF7.1/RF7.2: shared icon library. */
async function renderIcons() {
  const box = el("div", { class: "card" }, el("p", { class: "muted", text: t("icons_hint") }));
  const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true });
  file.onchange = guard(async () => { await uploadIcons(file.files); render(); });
  box.append(el("div", { class: "row" }, file));
  const grid = el("div", { class: "icon-grid" });
  box.append(grid);
  main.append(box);
  const lib = await api("GET", "api/icons");
  if (!lib.length) grid.append(el("p", { class: "muted", text: t("empty_list") }));
  for (const i of lib) {
    grid.append(el("div", { class: "icon-cell" }, iconImg(null, i.name, "big"), el("span", { text: i.name }),
      el("span", { class: "muted", text: `${Math.ceil(i.size / 1024)} kB` }),
      el("button", { class: "icon danger", text: t("delete"), onclick: guard(async () => {
        await iconDeleteDialog(i.name);
      }) })));
  }
}

/* RF10.11: delete an icon from the library and, optionally, from the remotes
 * that hold it but no longer reference it (DELETE /icons/<name>, app 1.2.7+).
 * Remotes whose dashboard still uses the icon cannot be selected. */
async function iconDeleteDialog(name) {
  const usage = await api("GET", `api/icons/${encodeURIComponent(name)}/usage`);
  const lib = el("input", { type: "checkbox", checked: true });
  const rows = usage.map((u) => {
    const cb = el("input", { type: "checkbox", disabled: u.used || u.on_remote === false });
    const note = u.used ? t("icon_in_use") : u.on_remote === false ? t("icon_not_on_remote") : u.on_remote == null ? t("icon_remote_unknown") : "";
    return { u, cb, row: el("label", { class: "row" }, cb, el("span", { text: u.name }), el("span", { class: "muted", text: note })) };
  });
  const dlg = el("dialog", {}, el("h3", { text: `${t("delete")} ${name}` }),
    el("label", { class: "row" }, lib, el("span", { text: t("icon_from_library") })),
    rows.length ? el("p", { class: "muted", text: t("icon_from_remotes") }) : null, ...rows.map((r) => r.row));
  document.body.append(dlg);
  return new Promise((resolve) => {
    const close = () => { dlg.close(); dlg.remove(); resolve(); };
    dlg.append(el("div", { class: "row" },
      el("button", { text: t("cancel"), onclick: close }),
      el("button", { class: "danger", text: t("delete"), onclick: guard(async () => {
        const ids = rows.filter((r) => r.cb.checked).map((r) => r.u.id);
        if (!lib.checked && !ids.length) return close();
        const q = new URLSearchParams({ library: lib.checked ? "1" : "0" });
        if (ids.length) q.set("remotes", ids.join(","));
        const res = await api("DELETE", `api/icons/${encodeURIComponent(name)}?${q}`);
        const bad = ((res && res.remotes) || []).filter((x) => x.result !== "deleted" && x.result !== "absent");
        toast(bad.length ? t("icon_delete_partial", { names: bad.map((x) => x.name).join(", ") }) : t("icon_deleted"), bad.length > 0);
        close(); render();
      }) })));
    dlg.showModal();
  });
}

function renderList() {
  const archived = S.view === "archive";
  main.replaceChildren();
  main.append(el("div", { class: "tabs" },
    el("button", { class: S.view === "list" ? "active" : "", text: t("remotes"), onclick: guard(async () => { S.view = "list"; await loadList(false); }) }),
    el("button", { class: archived ? "active" : "", text: t("archived"), onclick: guard(async () => { S.view = "archive"; await loadList(true); }) }),
    el("button", { class: S.view === "icons" ? "active" : "", text: t("icons"), onclick: () => { S.view = "icons"; render(); } }),
    el("button", { class: S.view === "themes" ? "active" : "", text: t("themes"), onclick: () => { S.view = "themes"; render(); } })));
  if (S.view === "icons") return renderIcons();
  if (S.view === "themes") return renderThemes().catch(handleError); // RF14.4
  if (!S.remotes.length) main.append(el("p", { class: "muted", text: t("empty_list") }));
  for (const r of S.remotes) {
    const info = el("div", {},
      el("div", { class: "row" }, el("strong", { text: r.name }), archived ? null : statusBadge(r.id)),
      el("div", { class: "muted", text: `${r.host}:${r.port} · ${r.width}×${r.height} ${t(r.orientation)}` }),
      el("div", { class: "muted", text: `${t("head")}: v${r.head} · ${t("last_push")}: ${r.last_push_version ? "v" + r.last_push_version : t("never")}` }),
      identityLine(r));
    const actions = archived
      ? el("div", { class: "row" }, el("button", { text: t("unarchive"), onclick: guard(async () => { await api("POST", `api/remotes/${r.id}/unarchive`); await loadList(true); }) }))
      : el("div", { class: "row" },
        el("button", { class: "primary", text: t("open"), onclick: guard(() => openRemote(r.id)) }),
        ...syncButtons(r, false),
        el("button", { text: t("edit"), onclick: () => remoteDialog(r) }),
        el("button", { class: "danger", text: t("archive"), onclick: guard(async () => {
          if (!confirm(t("confirm_archive"))) return;
          await api("POST", `api/remotes/${r.id}/archive`); await loadList(false);
        }) }));
    main.append(el("div", { class: "card row" }, info, el("span", { class: "spacer" }), actions));
  }
  if (!archived) main.append(el("button", { class: "primary", text: "＋ " + t("add_remote"), onclick: () => remoteDialog(null) }));
}

/* RF1.1 / RF1.3: register or edit a remote. No default for size/orientation. */
function remoteDialog(remote) {
  const v = remote || { port: 8080 };
  const inp = (key, type, opt) => {
    const i = el("input", { type, value: v[key] != null ? v[key] : "", placeholder: opt ? t("optional") : "" });
    if (key === "ir_entity") i.setAttribute("list", "entity-list");
    return [key, i];
  };
  const orient = el("select", {}, el("option", { value: "", text: t("choose") }),
    ...["portrait", "landscape"].map((o) => el("option", { value: o, text: t(o), selected: v.orientation === o })));
  const fields = [inp("name", "text"), inp("host", "text"), inp("port", "number"), inp("width", "number"),
    inp("height", "number"), ["orientation", orient], inp("harmony_ip", "text", true), inp("ir_entity", "text", true)];
  // RF12.2: pin named versions in the remote's own history (app 1.3.0+); off by default
  const pin = el("input", { type: "checkbox" });
  pin.checked = !!v.pin_named;
  // RF16.4: edit with the remote's own builder; the add-on keeps the backup
  const nbx = el("input", { type: "checkbox" });
  nbx.checked = !!v.native_builder;
  const msg = el("div", { class: "msg" });
  const dlg = el("dialog", {});
  const save = guard(async () => {
    const body = Object.fromEntries(fields.map(([k, i]) => [k, i.value]));
    body.pin_named = pin.checked;
    body.native_builder = nbx.checked;
    try {
      if (remote) await api("PATCH", `api/remotes/${remote.id}`, body);
      else await api("POST", "api/remotes", body);
      dlg.close(); dlg.remove(); await loadList(false);
    } catch (e) {
      const code = (e.data && e.data.error) || "internal";
      msg.textContent = t("err_" + code) + (e.data && e.data.detail ? ` (${e.data.detail})` : "");
    }
  });
  dlg.append(el("h2", { text: remote ? t("edit") : t("add_remote") }),
    el("div", { class: "grid" }, ...fields.map(([k, i]) => el("div", { class: "field" }, el("label", { text: t(k) }), i))),
    el("label", { class: "row", title: t("pin_named_hint") }, pin, t("pin_named")),
    el("label", { class: "row", title: t("nb_option_hint") }, nbx, t("nb_option")),
    el("div", { class: "field invalid" }, msg),
    el("div", { class: "row" }, el("span", { class: "spacer" }),
      el("button", { text: t("cancel"), onclick: () => { dlg.close(); dlg.remove(); } }),
      el("button", { class: "primary", text: remote ? t("save") : t("register"), onclick: save })));
  document.body.append(dlg);
  dlg.showModal();
}

async function openRemote(rid) {
  closeSim(); closeMap();
  S.view = "remote"; S.rid = rid; S.tab = "editor"; editor = null;
  main.replaceChildren(el("p", { class: "muted", text: t("loading") }));
  await loadRemote();
}

let editor = null;
let sim = null;

/* Stop the simulator live stream when leaving the remote/tab. */
function closeSim() { if (sim) { sim.close(); sim = null; } }

/* RF13: navigation map above the Editor and the Simulator (one per open remote). */
let navmap = null;
let bigprev = null; // RF17
function closeMap() { if (navmap) { navmap.close(); navmap = null; } bigprev = null; }
function mapSelect(target) {
  if (S.tab === "simulator") {
    if (sim && target.p !== undefined) { sim.cur = target.p; sim.popup = null; sim.overlay = null; sim.render(); }
    return;
  }
  if (!editor) return;
  // 2.22: a click on the map reopens a collapsed Editor (the selection must be visible)
  const wrap = document.querySelector(".editor-wrap");
  if (wrap && wrap.hidden) document.querySelector(".editor-head button").click();
  if (target.kind === "path") return editor.reveal(target.path);
  editor.sel = target.kind === "card" ? { kind: "card", p: target.p, c: target.c } : { kind: "page", p: target.p };
  editor.render();
}

function renderRemote() {
  const r = S.remote;
  main.replaceChildren();
  main.append(el("div", { class: "row" },
    el("button", { text: "← " + t("back"), onclick: guard(async () => { closeSim(); closeMap(); S.view = "list"; await loadList(false); }) }),
    el("h2", { text: r.name }), statusBadge(r.id), el("span", { class: "muted", text: `${t("head")}: v${r.head}` }),
    el("span", { class: "spacer" }), ...builderButtons(r), ...syncButtons(r, true),
    el("button", { text: "↶ " + t("undo"), disabled: !r.can_undo || r.native_builder, onclick: guard(async () => applyResult(await api("POST", `api/remotes/${S.rid}/undo`, { head: r.head }))) }),
    el("button", { text: "↷ " + t("redo"), disabled: !r.can_redo || r.native_builder, onclick: guard(async () => applyResult(await api("POST", `api/remotes/${S.rid}/redo`, { head: r.head }))) })));
  const nb = nativeBanner(r); // RF16.4
  if (nb) main.append(nb);
  if (S.drift[r.id] === "drift" && !S.ignored.has(r.id)) main.append(driftBanner());
  main.append(el("div", { class: "tabs" }, ...["editor", "simulator", "history", "sync"].map((tab) =>
    el("button", { class: S.tab === tab ? "active" : "", text: t("tab_" + tab), onclick: () => { if (tab !== "simulator") closeSim(); S.tab = tab; render(); } }))));
  if (S.tab === "editor" || S.tab === "simulator") {
    // RF15: map edits are ordinary commits (one version each, undoable)
    if (!navmap) navmap = new NavMap({ rid: S.rid, remote: S.remote, doc: S.doc, hwKeys: S.hwKeys, onSelect: mapSelect, onCommit: commit,
      canEdit: () => !(S.remote && S.remote.native_builder) });
    navmap.setDoc(S.doc, S.remote, S.tab);
    main.append(navmap.root);
  }
  const body = el("div", {});
  if (S.tab === "editor") {
    // RF17: big preview of the selected screen in a pane on the left
    if (!bigprev) bigprev = new BigPreview({ map: navmap, onSelect: mapSelect });
    // 2.22: the Editor can be collapsed like the map (chevron, remembered in the browser)
    const wrap = el("div", { class: "editor-wrap" }, bigprev.root, body);
    const edOpen = () => mapStore("acm-editor-open") !== "0";
    const edToggle = el("button", { class: "icon", title: t("editor_toggle"), text: edOpen() ? "▴" : "▾", onclick: () => {
      const open = !edOpen();
      mapStore("acm-editor-open", open ? "1" : "0");
      edToggle.textContent = open ? "▴" : "▾";
      wrap.hidden = !open;
      console.debug(`[acm] editor ${open ? "shown" : "hidden"}`);
    } });
    wrap.hidden = !edOpen();
    main.append(el("div", { class: "card editor-head row" }, edToggle, el("strong", { text: "✎ " + t("tab_editor") }),
      el("span", { class: "muted", text: t("editor_hint") })), wrap);
  } else main.append(body);
  if (S.tab === "editor") {
    if (!editor) {
      editor = new Editor({ schema: S.schema, hints: S.hints, hwKeys: S.hwKeys, commit, copy: copyDialog, rid: S.rid,
        entities: () => S.entities, remote: () => S.remote, pickIcon: (cb) => openIconPicker(S.rid, cb) });
    }
    editor.root = body;
    body.classList.toggle("readonly", !!r.native_builder); // RF16.4
    editor.onRender = (sel) => { if (navmap) navmap.highlight(sel); if (bigprev) bigprev.setSel(sel); };
    editor.setDoc(S.doc, S.validation);
  } else if (S.tab === "simulator") {
    // RF6.1: the simulator follows the head and is refreshed on every version.
    if (!sim) sim = new Simulator({ rid: S.rid, remote: S.remote, doc: S.doc });
    sim.root = body;
    sim.onRender = (cur) => { if (navmap) navmap.highlight({ kind: "page", p: cur }); };
    sim.setDoc(S.doc, S.remote);
  } else if (S.tab === "history") {
    renderHistory(body);
  } else {
    renderSync(body);
  }
}

/* RF10.9: identity reported by the remote (GET /info, app 1.2.7+), read-only;
 * two entries pointing at the same physical remote are flagged. */
function identityLine(r) {
  const id = r.identity;
  if (!id) return null;
  const parts = [id.name, [id.manufacturer, id.model].filter(Boolean).join(" "), id.version && `app ${id.version}`].filter(Boolean);
  return el("div", {},
    el("div", { class: "muted", text: `📟 ${parts.join(" · ")}` }),
    r.duplicate_of && r.duplicate_of.length ? el("div", { class: "msg warn", text: "⚠ " + t("identity_duplicate", { names: r.duplicate_of.join(", ") }) }) : null);
}

/* RF12.3: why the remote's file changed, from its newest history entry. */
function remoteLastText(e) {
  const when = e.time ? new Date(e.time).toLocaleString(LANG) : e.id;
  if (e.reason === "restore") return t("rh_last_restore", { id: e.restoredFrom || "?", when });
  if (e.reason === "outside") return t("rh_last_outside", { when });
  if (e.addon_version) return t("rh_last_addon", { v: e.addon_version, when });
  return t("rh_last_save", { note: e.note || "—", when });
}

/* RF5.3: drift is only reported; the user picks import / overwrite / ignore.
 * RF10.12: the changed keys are listed; keys written by the remote's own
 * Settings screen (dock mode, screen timeout) are pointed out. */
function driftBanner() {
  const ch = S.driftChanges[S.rid];
  const detail = ch && ch.count ? el("div", { class: "muted" },
    el("div", { text: t("drift_changes", { n: ch.count }) + " " + ch.paths.join(", ") + (ch.count > ch.paths.length ? " …" : "") }),
    ch.settings_only ? el("div", { text: t("drift_settings_only") }) : null,
    ch.remote_last ? el("div", { text: "🕘 " + remoteLastText(ch.remote_last) }) : null) : null;
  return el("div", { class: "card banner row" }, el("div", {}, el("span", { text: "⚠ " + t("drift_banner") }), detail), el("span", { class: "spacer" }),
    el("button", { text: t("import_version"), onclick: guard(doPull) }),
    el("button", { text: t("overwrite"), onclick: guard(doPush) }),
    el("button", { text: t("ignore"), onclick: () => { S.ignored.add(S.rid); render(); } }));
}

/* RF5.4 / RF5.5 pull and push. Shared by the Sync tab, the drift banner and
 * (RF11.8) the remote list and the remote header: same API calls, same
 * validation (push refused by the backend on errors), same messages. */
async function pullRemote(rid, head) {
  const res = await api("POST", `api/remotes/${rid}/pull`, { head });
  S.drift[rid] = "in_sync";
  toast(res.version ? `${t("saved_version")} v${res.version.id}` : t("pull_none"));
  return res;
}
async function pushRemote(rid, head) {
  const res = await api("POST", `api/remotes/${rid}/push`, { head });
  S.drift[rid] = "in_sync";
  toast((res.drift_overwritten ? t("push_ok_drift") : t("push_ok"))
    + (res.icons_uploaded && res.icons_uploaded.length ? ` · ${t("icons_uploaded")}: ${res.icons_uploaded.join(", ")}` : "")
    + (res.remote_pinned ? ` · 📌 ${t("rh_pinned_on_remote")}` : ""));
  return res;
}
/* RF11.8: from the list / header a push over a drifted remote asks first
 * (the drift banner's "Overwrite" and the Sync tab keep their direct action). */
const confirmDriftPush = (rid) => S.drift[rid] !== "drift" || confirm(t("confirm_push_drift"));

async function doPull() {
  applyResult(await pullRemote(S.rid, S.remote.head));
}

async function doPush() {
  const res = await pushRemote(S.rid, S.remote.head);
  S.remote = res.remote;
  render();
}

/* RF11.8 quick actions (list cards and remote header). */
function syncButtons(r, inRemote) {
  return [
    el("button", { text: "⬇ " + t("pull"), title: t("pull_hint"), onclick: guard(async () => {
      if (inRemote) return doPull();
      await pullRemote(r.id, r.head); await loadList(false);
    }) }),
    el("button", { class: inRemote ? "primary" : "", text: "⬆ " + t("push"), title: t("push_hint"),
      disabled: inRemote && S.validation ? !S.validation.push_allowed : false, onclick: guard(async () => {
        if (!confirmDriftPush(r.id)) return;
        if (inRemote) return doPush();
        await pushRemote(r.id, r.head); await loadList(false);
      }) }),
  ];
}

/* RF5.4 / RF5.5 */
function renderSync(body) {
  const r = S.remote;
  const v = S.validation || { issues: [] };
  body.append(el("div", { class: "card" },
    el("div", { class: "row" }, el("strong", { text: t("status") + ":" }), statusBadge(r.id),
      el("button", { text: t("check_drift"), onclick: guard(async () => {
        const d = await api("GET", `api/remotes/${S.rid}/drift`);
        S.drift[S.rid] = d.status; S.driftChanges[S.rid] = d.changes; S.ignored.delete(S.rid); render();
      }) })),
    el("p", { text: `${t("head")}: v${r.head} · ${t("last_push")}: ${r.last_push_version ? "v" + r.last_push_version : t("never")}` +
      (r.last_push_at ? ` (${new Date(r.last_push_at * 1000).toLocaleString(LANG)})` : "") }),
    v.entities_checked === false ? el("p", { class: "muted", text: "⚠ " + t("entities_unchecked") }) : null,
    el("div", { class: "row" },
      el("button", { text: "⬇ " + t("pull"), onclick: guard(doPull) }),
      el("button", { class: "primary", text: "⬆ " + t("push"), disabled: !v.push_allowed, onclick: guard(doPush) })),
    v.issues.length ? el("p", { class: "msg", text: `${t("err_push_blocked")} (${v.issues.length})` }) : null));
  // RF8.1: hubs and extenders read from the remote (read-only)
  const hubs = r.harmony_hubs || [], exts = r.extenders || [];
  body.append(el("div", { class: "card" }, el("div", { class: "row" }, el("h3", { text: t("hubs_extenders") }), el("span", { class: "spacer" }),
    el("button", { text: "⟳ " + t("refresh"), onclick: guard(async () => { S.remote = await api("POST", `api/remotes/${S.rid}/devices/refresh`); toast(t("refreshed")); render(); }) })),
  el("p", { class: "muted", text: r.devices_read_at ? `${t("read_from_remote")}: ${new Date(r.devices_read_at * 1000).toLocaleString(LANG)}` : t("never_read") }),
  el("strong", { text: "Harmony" }),
  ...(hubs.length ? hubs.map((h, i) => el("div", { class: "list-item" }, el("span", { text: `${h.name || h.localId}` }), el("span", { class: "muted", text: `${h.ip}${i === 0 ? " · " + t("default_hub") : ""}` })))
    : [el("p", { class: "muted", text: r.harmony_ip ? `${t("fallback_ip")}: ${r.harmony_ip}` : t("none") })]),
  el("strong", { text: t("ir_targets") }),
  el("div", { class: "list-item" }, el("span", { text: t("local") }), el("span", { class: "muted", text: r.ir_entity || t("sim_no_ir") })),
  ...exts.map((x) => el("div", { class: "list-item" }, el("span", { text: `${t("extender")}: ${x.name || x.localId}` }), el("span", { class: "muted", text: x.host })))));
  // RF7.3: icons stored on this remote; import them into the shared library
  const iconBox = el("div", { class: "card" }, el("h3", { text: t("icons_on_remote") }), el("p", { class: "muted", text: t("loading") }));
  body.append(iconBox);
  api("GET", `api/remotes/${S.rid}/icons`).then((lst) => {
    const lib = new Set(lst.library);
    iconBox.replaceChildren(el("h3", { text: t("icons_on_remote") }));
    if (lst.device === null) { iconBox.append(el("p", { class: "muted", text: t("st_unreachable") })); return; }
    const missing = lst.device.filter((n) => !lib.has(n));
    iconBox.append(el("p", { class: "muted", text: `${lst.device.length} · ${t("not_in_library")}: ${missing.length}` }),
      el("div", { class: "icon-grid" }, ...lst.device.map((n) => el("div", { class: "icon-cell" }, iconImg(S.rid, n, "big"), el("span", { text: n })))),
      el("button", { text: t("import_icons"), disabled: !missing.length, onclick: guard(async () => {
        const r = await api("POST", `api/remotes/${S.rid}/icons/import`);
        toast(`${t("icons_added")}: ${r.imported.length}`); render();
      }) }));
  }).catch(handleError);
}

/* RF2.7 history, RF2.11-RF2.13 names, RF2.6 restore. */
async function renderHistory(body) {
  body.append(el("p", { class: "muted", text: t("loading") }));
  const h = await api("GET", `api/remotes/${S.rid}/versions`);
  body.replaceChildren();
  const named = h.versions.filter((v) => v.name);
  if (named.length) {
    body.append(el("div", { class: "card" }, el("h3", { text: t("named_versions") }),
      ...named.map((v) => el("div", { class: "list-item" }, el("span", { class: "badge name", text: v.name }),
        el("span", { text: `v${v.id}` }), el("span", { class: "spacer" }),
        el("button", { text: t("restore"), onclick: guard(() => restoreVersion(v)) })))));
  }
  const only = el("input", { type: "checkbox" });
  only.checked = S.onlyNamed;
  only.onchange = () => { S.onlyNamed = only.checked; render(); };
  const card = el("div", { class: "card" }, el("div", { class: "row" }, el("h3", { text: t("versions") }), el("span", { class: "spacer" }),
    el("label", { class: "row" }, only, t("only_named"))));
  for (const v of h.versions.filter((x) => !S.onlyNamed || x.name)) {
    const detail = el("pre", { hidden: true });
    const ops = v.ops.map((o) => `${o.op} ${o.path}`).join("\n") + (v.op_count > v.ops.length ? `\n… +${v.op_count - v.ops.length} ${t("ops_more")}` : "");
    card.append(el("div", { class: "list-item" },
      el("strong", { text: `v${v.id}` }), el("span", { class: "badge", text: t("type_" + v.type) + (v.ref ? ` → v${v.ref}` : "") }),
      v.name ? el("span", { class: "badge name", text: v.name }) : null,
      v.origin && v.origin.remote_version ? el("span", { class: "badge", title: v.origin.note || "",
        text: `🕘 ${t("rh_from_remote")} ${v.origin.remote_version}` }) : null,
      el("span", { class: "muted", text: `${new Date(v.ts * 1000).toLocaleString(LANG)}${v.user ? ` · ${t("by")} ${v.user}` : ""}` }),
      el("span", { class: "spacer" }),
      el("button", { class: "icon", text: t("delta"), onclick: guard(async () => {
        if (detail.hidden && !detail.textContent) {
          const full = await api("GET", `api/remotes/${S.rid}/versions/${v.id}`);
          detail.textContent = JSON.stringify(full.patch, null, 2);
        }
        detail.hidden = !detail.hidden;
      }) }),
      el("button", { class: "icon", text: t("set_name"), onclick: guard(async () => {
        const name = prompt(t("name_prompt"), v.name || "");
        if (name === null) return;
        await api("PUT", `api/remotes/${S.rid}/versions/${v.id}/name`, { name });
        render();
      }) }),
      v.id !== h.head ? el("button", { class: "icon", text: t("restore"), onclick: guard(() => restoreVersion(v)) }) : null,
      el("div", { class: "ops", style: "flex-basis:100%", text: ops }), detail));
  }
  body.append(card);
  body.append(await remoteHistoryCard());
}

/* RF12.4: the remote's own version history (app 1.3.0), read-only. The add-on
 * stays the source of truth: a remote version is imported as a new add-on
 * version (then pushed), never restored on the remote from here (RF12.5). */
async function remoteHistoryCard() {
  const card = el("div", { class: "card" }, el("h3", { text: t("rh_title") }), el("p", { class: "muted", text: t("rh_hint") }));
  let h;
  try { h = await api("GET", `api/remotes/${S.rid}/remote-history`); } catch (e) {
    card.append(el("p", { class: "msg", text: t("err_" + ((e.data && e.data.error) || "internal")) }));
    return card;
  }
  if (!h.supported) { card.append(el("p", { class: "muted", text: t("rh_unsupported") })); return card; }
  if (!h.versions.length) card.append(el("p", { class: "muted", text: t("empty_list") }));
  for (const v of h.versions) {
    const out = el("div", { class: "ops", style: "flex-basis:100%", hidden: true });
    card.append(el("div", { class: "list-item" },
      el("strong", { text: v.time ? new Date(v.time).toLocaleString(LANG) : v.id }),
      el("span", { class: "badge", text: t("rh_reason_" + (v.reason || "save")) + (v.restoredFrom ? ` ← ${v.restoredFrom}` : "") }),
      v.addon_version ? el("span", { class: "badge in_sync", text: `${t("rh_from_addon")} v${v.addon_version}` }) : el("span", { class: "badge", text: t("rh_on_remote") }),
      v.pinned ? el("span", { title: t("rh_pinned"), text: "📌" }) : null,
      v.note ? el("span", { text: v.note }) : null,
      el("span", { class: "muted", text: `${v.pages} ${t("rh_pages")} · ${v.cards} ${t("rh_cards")}` }),
      el("span", { class: "spacer" }),
      el("button", { class: "icon", text: t("rh_compare"), onclick: guard(async () => {
        if (out.hidden) {
          const d = await api("GET", `api/remotes/${S.rid}/remote-history/${v.id}/diff`);
          out.textContent = d.count ? `${t("rh_diff", { n: d.count })}\n${d.paths.join("\n")}${d.count > d.paths.length ? "\n…" : ""}` : t("rh_same");
        }
        out.hidden = !out.hidden;
      }) }),
      el("a", { class: "button icon", href: `api/remotes/${S.rid}/remote-history/${v.id}`, download: `dashboard-${v.id}.json`, text: t("rh_download") }),
      el("button", { class: "icon", text: t("rh_import"), onclick: guard(async () => {
        if (!confirm(t("rh_import_confirm", { id: v.id }))) return;
        const res = await api("POST", `api/remotes/${S.rid}/remote-history/${v.id}/import`, { head: S.remote.head });
        if (res.remote.baseline_version === res.remote.head) S.drift[S.rid] = "in_sync";
        applyResult(res);
        toast(res.version ? `${t("saved_version")} v${res.version.id}` : t("rh_same"));
      }) }),
      out));
  }
  return card;
}

async function restoreVersion(v) {
  if (!confirm(`${t("confirm_restore")} v${v.id}${v.name ? ` (${v.name})` : ""}?`)) return;
  const res = await api("POST", `api/remotes/${S.rid}/restore`, { head: S.remote.head, version: v.id });
  applyResult(res);
  toast(`${t("saved_version")} v${res.version.id}`);
}

/* RF3.3: copy pages/cards to another remote (one version on destination). */
async function copyDialog(kind, payload) {
  const all = await api("GET", "api/remotes");
  const dst = el("select", {}, ...all.map((r) => el("option", { value: r.id, text: r.name + (r.id === S.rid ? " (=)" : "") })));
  const pageSel = el("select", {});
  const loadPages = guard(async () => {
    const st = await api("GET", `api/remotes/${dst.value}/state`);
    pageSel.replaceChildren(...((st.state && st.state.pages) || []).map((p, i) => el("option", { value: i, text: p.name || i })));
    pageSel.dataset.head = st.remote.head;
  });
  dst.onchange = loadPages;
  const dlg = el("dialog", {});
  dlg.append(el("h2", { text: t("copy_to") }),
    el("div", { class: "field" }, el("label", { text: t("destination") }), dst),
    kind === "cards" ? el("div", { class: "field" }, el("label", { text: t("dest_page") }), pageSel) : null,
    el("div", { class: "row" }, el("span", { class: "spacer" }),
      el("button", { text: t("cancel"), onclick: () => { dlg.close(); dlg.remove(); } }),
      el("button", { class: "primary", text: t("copy"), onclick: guard(async () => {
        const body = { src: S.rid, dst: dst.value, kind, head: parseInt(pageSel.dataset.head, 10), ...payload };
        if (kind === "cards") body.dst_page = parseInt(pageSel.value, 10);
        const res = await api("POST", "api/copy", body);
        dlg.close(); dlg.remove();
        toast(t("copied"));
        if (dst.value === S.rid) applyResult(res);
      }) })));
  document.body.append(dlg);
  await loadPages();
  dlg.showModal();
}

/* ---------- start ---------- */
(async function start() {
  try {
    const [meta, schema, hints] = await Promise.all([api("GET", "api/meta"), api("GET", `static/card_schema.json?v=${document.documentElement.dataset.version}`), api("GET", `static/field_hints.json?v=${document.documentElement.dataset.version}`)]);
    S.schema = schema; S.hwKeys = meta.hardware_keys; S.hints = hints;
    if (meta.user) document.getElementById("user").textContent = meta.user;
    document.documentElement.lang = LANG;
    await loadList(false);
    // Entity autocomplete for the editor (best effort).
    S.entities = await api("GET", "api/entities");
    refreshEntityList();
  } catch (e) { await handleError(e); }
})();
