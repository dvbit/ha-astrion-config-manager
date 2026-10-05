/* Astrion Config Manager panel (spec RF1, RF2, RF5; editor in editor.js,
 * simulator in simulator.js - RF6).
 * Views: remote list / archive (RF1.4, RF5.5) and remote detail with tabs
 * Editor (RF3), History (RF2.7, RF2.11-2.13) and Sync (RF5). */
"use strict";

const S = {
  view: "list",        // "list" | "archive" | "remote"
  remotes: [],
  drift: {},           // remote id -> drift status (RF5.2)
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
  for (const d of res) { S.drift[d.id] = d.status; S.ignored.delete(d.id); }
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
}

/* Commit from the editor (RF2.3). */
async function commit(newDoc) {
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
        if (!confirm(`${t("confirm_icon_delete")} ${i.name}?`)) return;
        await api("DELETE", `api/icons/${encodeURIComponent(i.name)}`); render();
      }) })));
  }
}

function renderList() {
  const archived = S.view === "archive";
  main.replaceChildren();
  main.append(el("div", { class: "tabs" },
    el("button", { class: S.view === "list" ? "active" : "", text: t("remotes"), onclick: guard(async () => { S.view = "list"; await loadList(false); }) }),
    el("button", { class: archived ? "active" : "", text: t("archived"), onclick: guard(async () => { S.view = "archive"; await loadList(true); }) }),
    el("button", { class: S.view === "icons" ? "active" : "", text: t("icons"), onclick: () => { S.view = "icons"; render(); } })));
  if (S.view === "icons") return renderIcons();
  if (!S.remotes.length) main.append(el("p", { class: "muted", text: t("empty_list") }));
  for (const r of S.remotes) {
    const info = el("div", {},
      el("div", { class: "row" }, el("strong", { text: r.name }), archived ? null : statusBadge(r.id)),
      el("div", { class: "muted", text: `${r.host}:${r.port} · ${r.width}×${r.height} ${t(r.orientation)}` }),
      el("div", { class: "muted", text: `${t("head")}: v${r.head} · ${t("last_push")}: ${r.last_push_version ? "v" + r.last_push_version : t("never")}` }));
    const actions = archived
      ? el("div", { class: "row" }, el("button", { text: t("unarchive"), onclick: guard(async () => { await api("POST", `api/remotes/${r.id}/unarchive`); await loadList(true); }) }))
      : el("div", { class: "row" },
        el("button", { class: "primary", text: t("open"), onclick: guard(() => openRemote(r.id)) }),
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
  const msg = el("div", { class: "msg" });
  const dlg = el("dialog", {});
  const save = guard(async () => {
    const body = Object.fromEntries(fields.map(([k, i]) => [k, i.value]));
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
    el("div", { class: "field invalid" }, msg),
    el("div", { class: "row" }, el("span", { class: "spacer" }),
      el("button", { text: t("cancel"), onclick: () => { dlg.close(); dlg.remove(); } }),
      el("button", { class: "primary", text: remote ? t("save") : t("register"), onclick: save })));
  document.body.append(dlg);
  dlg.showModal();
}

async function openRemote(rid) {
  closeSim();
  S.view = "remote"; S.rid = rid; S.tab = "editor"; editor = null;
  main.replaceChildren(el("p", { class: "muted", text: t("loading") }));
  await loadRemote();
}

let editor = null;
let sim = null;

/* Stop the simulator live stream when leaving the remote/tab. */
function closeSim() { if (sim) { sim.close(); sim = null; } }

function renderRemote() {
  const r = S.remote;
  main.replaceChildren();
  main.append(el("div", { class: "row" },
    el("button", { text: "← " + t("back"), onclick: guard(async () => { closeSim(); S.view = "list"; await loadList(false); }) }),
    el("h2", { text: r.name }), statusBadge(r.id), el("span", { class: "muted", text: `${t("head")}: v${r.head}` }),
    el("span", { class: "spacer" }),
    el("button", { text: "↶ " + t("undo"), disabled: !r.can_undo, onclick: guard(async () => applyResult(await api("POST", `api/remotes/${S.rid}/undo`, { head: r.head }))) }),
    el("button", { text: "↷ " + t("redo"), disabled: !r.can_redo, onclick: guard(async () => applyResult(await api("POST", `api/remotes/${S.rid}/redo`, { head: r.head }))) })));
  if (S.drift[r.id] === "drift" && !S.ignored.has(r.id)) main.append(driftBanner());
  main.append(el("div", { class: "tabs" }, ...["editor", "simulator", "history", "sync"].map((tab) =>
    el("button", { class: S.tab === tab ? "active" : "", text: t("tab_" + tab), onclick: () => { if (tab !== "simulator") closeSim(); S.tab = tab; render(); } }))));
  const body = el("div", {});
  main.append(body);
  if (S.tab === "editor") {
    if (!editor) {
      editor = new Editor({ schema: S.schema, hwKeys: S.hwKeys, commit, copy: copyDialog, rid: S.rid,
        entities: () => S.entities, pickIcon: (cb) => openIconPicker(S.rid, cb) });
    }
    editor.root = body;
    editor.setDoc(S.doc, S.validation);
  } else if (S.tab === "simulator") {
    // RF6.1: the simulator follows the head and is refreshed on every version.
    if (!sim) sim = new Simulator({ rid: S.rid, remote: S.remote, doc: S.doc });
    sim.root = body;
    sim.setDoc(S.doc, S.remote);
  } else if (S.tab === "history") {
    renderHistory(body);
  } else {
    renderSync(body);
  }
}

/* RF5.3: drift is only reported; the user picks import / overwrite / ignore. */
function driftBanner() {
  return el("div", { class: "card banner row" }, el("span", { text: "⚠ " + t("drift_banner") }), el("span", { class: "spacer" }),
    el("button", { text: t("import_version"), onclick: guard(doPull) }),
    el("button", { text: t("overwrite"), onclick: guard(doPush) }),
    el("button", { text: t("ignore"), onclick: () => { S.ignored.add(S.rid); render(); } }));
}

async function doPull() {
  const res = await api("POST", `api/remotes/${S.rid}/pull`, { head: S.remote.head });
  S.drift[S.rid] = "in_sync";
  applyResult(res);
  toast(res.version ? `${t("saved_version")} v${res.version.id}` : t("pull_none"));
}

async function doPush() {
  const res = await api("POST", `api/remotes/${S.rid}/push`, { head: S.remote.head });
  S.drift[S.rid] = "in_sync";
  S.remote = res.remote;
  render();
  toast((res.drift_overwritten ? t("push_ok_drift") : t("push_ok"))
    + (res.icons_uploaded && res.icons_uploaded.length ? ` · ${t("icons_uploaded")}: ${res.icons_uploaded.join(", ")}` : ""));
}

/* RF5.4 / RF5.5 */
function renderSync(body) {
  const r = S.remote;
  const v = S.validation || { issues: [] };
  body.append(el("div", { class: "card" },
    el("div", { class: "row" }, el("strong", { text: t("status") + ":" }), statusBadge(r.id),
      el("button", { text: t("check_drift"), onclick: guard(async () => {
        const d = await api("GET", `api/remotes/${S.rid}/drift`);
        S.drift[S.rid] = d.status; S.ignored.delete(S.rid); render();
      }) })),
    el("p", { text: `${t("head")}: v${r.head} · ${t("last_push")}: ${r.last_push_version ? "v" + r.last_push_version : t("never")}` +
      (r.last_push_at ? ` (${new Date(r.last_push_at * 1000).toLocaleString(LANG)})` : "") }),
    v.entities_checked === false ? el("p", { class: "muted", text: "⚠ " + t("entities_unchecked") }) : null,
    el("div", { class: "row" },
      el("button", { text: "⬇ " + t("pull"), onclick: guard(doPull) }),
      el("button", { class: "primary", text: "⬆ " + t("push"), disabled: !v.push_allowed, onclick: guard(doPush) })),
    v.issues.length ? el("p", { class: "msg", text: `${t("err_push_blocked")} (${v.issues.length})` }) : null));
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
    const [meta, schema] = await Promise.all([api("GET", "api/meta"), api("GET", "static/card_schema.json")]);
    S.schema = schema; S.hwKeys = meta.hardware_keys;
    if (meta.user) document.getElementById("user").textContent = meta.user;
    document.documentElement.lang = LANG;
    await loadList(false);
    // Entity autocomplete for the editor (best effort).
    S.entities = await api("GET", "api/entities");
    refreshEntityList();
  } catch (e) { await handleError(e); }
})();
