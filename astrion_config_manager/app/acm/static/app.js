/* Astrion Config Manager panel - 3.0: page-linking and full-screen test tool
 * (spec RF21). Single-screen editing is done in the Astrion app's own builder,
 * embedded in the "Builder" tab (builder.js); the add-on keeps no versions:
 * every change is written straight to the remote, which keeps the history.
 * Views: remote list / archive (RF1.4), icons (RF7), themes (RF14) and a
 * remote with three full-screen tabs: Map (map.js), Simulate (sim.js),
 * Builder (builder.js).
 */
"use strict";

const S = {
  view: "list",        // "list" | "archive" | "icons" | "themes" | "remote"
  remotes: [],
  rid: null, tab: "map", remote: null, doc: null, hash: null, info: null,
  sel: null,           // page selected on the map (builder deep link, simulation start)
  hints: {},
};
let navmap = null, sim = null, renderer = null;

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

/* Error codes from the backend are translated (RNF3). */
async function handleError(err) {
  const code = (err && err.data && err.data.error) || "internal";
  console.error("[acm]", err);
  toast(t("err_" + code) + (err && err.data && err.data.detail ? ` (${err.data.detail})` : ""), true);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { await handleError(e); } };

/* ---------- loading ---------- */
async function loadList(archived) {
  S.remotes = await api("GET", "api/remotes" + (archived ? "?archived=1" : ""));
  render();
}

/* RF21.5 the remote's document as it is now (the add-on keeps no copy). */
async function reloadLive(msg) {
  const data = await api("GET", `api/remotes/${S.rid}/live`);
  S.remote = data.remote; S.doc = data.doc; S.hash = data.hash; S.info = data.info;
  if (msg) toast(msg);
  console.info(`[acm] live document of '${S.remote.name}' loaded (${(S.doc.pages || []).length} pages)`);
  render();
}

/* RF21.5 write a change straight to the remote with a note. If the remote
 * changed since it was loaded (builder, another panel) nothing is written:
 * the current document is shown and the user decides. */
async function liveWrite(next, note) {
  try {
    const res = await api("PUT", `api/remotes/${S.rid}/live`, { doc: next, hash: S.hash, note });
    S.doc = res.doc; S.hash = res.hash;
    toast(`${t("written")}: ${note.replace(/^ACM: /, "")}`);
    console.info(`[acm] written: ${note} (remote version ${res.version_id || "?"})`);
    render();
  } catch (e) {
    if (e.data && e.data.error === "remote_changed") {
      S.doc = e.data.doc; S.hash = e.data.hash;
      render();
      await mapConfirm(t("remote_changed_reloaded"), true);
      return;
    }
    throw e;
  }
}

/* ---------- views ---------- */
function render() {
  document.getElementById("title").textContent = t("app_title");
  document.body.classList.toggle("full", S.view === "remote");
  if (S.view === "remote") return renderRemote();
  closeRemote();
  return renderList();
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
  main.append(el("div", { class: "card banner" }, el("strong", { text: "ℹ " + t("scope_title") }), el("div", { class: "muted", text: t("scope_text") })));
  if (!S.remotes.length) main.append(el("p", { class: "muted", text: t("empty_list") }));
  for (const r of S.remotes) {
    const info = el("div", {},
      el("div", { class: "row" }, el("strong", { text: r.name })),
      el("div", { class: "muted", text: `${r.host}:${r.port} · ${r.width}×${r.height} ${t(r.orientation)}` }),
      identityLine(r));
    const actions = archived
      ? el("div", { class: "row" }, el("button", { text: t("unarchive"), onclick: guard(async () => { await api("POST", `api/remotes/${r.id}/unarchive`); await loadList(true); }) }))
      : el("div", { class: "row" },
        el("button", { class: "primary", text: "🗺 " + t("open"), onclick: guard(() => openRemote(r.id, "map")) }),
        el("button", { text: "▶ " + t("tab_simulate"), onclick: guard(() => openRemote(r.id, "sim")) }),
        el("button", { text: "🛠 " + t("tab_builder"), onclick: guard(() => openRemote(r.id, "builder")) }),
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
  const inp = (key, type, opt) => [key, el("input", { type, value: v[key] != null ? v[key] : "", placeholder: opt ? t("optional") : "" })];
  const orient = el("select", {}, el("option", { value: "", text: t("choose") }),
    ...["portrait", "landscape"].map((o) => el("option", { value: o, text: t(o), selected: v.orientation === o })));
  const fields = [inp("name", "text"), inp("host", "text"), inp("port", "number"), inp("width", "number"),
    inp("height", "number"), ["orientation", orient]];
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

/* ---------- a remote: Map / Simulate / Builder (RF21) ---------- */
async function openRemote(rid, tab) {
  closeRemote();
  S.view = "remote"; S.rid = rid; S.tab = tab || "map"; S.sel = null;
  main.replaceChildren(el("p", { class: "muted", text: t("loading") }));
  await reloadLive(null);
}
function closeRemote() {
  if (navmap) { navmap.close(); navmap = null; }
  if (sim) { sim.close(); sim = null; }
  if (renderer) { renderer.close(); renderer = null; }
}

/* Map click: select a page (builder deep link, simulation start); while the
 * Simulate tab is open a click moves the simulation there. */
function mapSelect(target) {
  if (target && Number.isInteger(target.p)) S.sel = target.p;
  else if (target && target.path) { const m = target.path.match(/^\/pages\/(\d+)/); if (m) S.sel = +m[1]; }
  if (navmap) navmap.highlight(Number.isInteger(S.sel) ? { kind: "page", p: S.sel } : null, true);
}

function renderRemote() {
  const r = S.remote;
  main.replaceChildren();
  const tabBtn = (id, label) => el("button", { class: S.tab === id ? "active" : "", text: label, onclick: () => {
    if (S.tab === id) return;
    if (S.tab === "sim" && sim) { sim.close(); sim = null; }
    S.tab = id; render();
  } });
  const app = S.info && S.info.version ? `app ${S.info.version}` : "";
  main.append(el("div", { class: "row remote-head" },
    el("button", { class: "icon", text: "← " + t("remotes"), onclick: guard(async () => { S.view = "list"; await loadList(false); }) }),
    el("strong", { text: r.name }), el("span", { class: "muted", text: `${r.host}:${r.port} ${app}` }),
    el("div", { class: "tabs inline" }, tabBtn("map", "🗺 " + t("tab_map")), tabBtn("sim", "▶ " + t("tab_simulate")), tabBtn("builder", "🛠 " + t("tab_builder"))),
    el("span", { class: "spacer" }),
    el("button", { class: "icon", text: "⟳ " + t("reload"), title: t("reload_hint"), onclick: guard(() => reloadLive(t("reloaded"))) })));
  const body = el("div", { class: "remote-body" });
  main.append(body);
  if (!renderer && S.tab !== "builder") renderer = new Renderer(S.rid);
  if (S.tab === "map") {
    if (!navmap) {
      navmap = new NavMap({ rid: S.rid, remote: r, doc: S.doc, renderer, onSelect: mapSelect, onCommit: guard(liveWrite) });
    }
    navmap.renderer = renderer;
    navmap.setDoc(S.doc, r, "editor");
    body.append(navmap.root);
    if (Number.isInteger(S.sel)) navmap.highlight({ kind: "page", p: S.sel }, true);
    requestAnimationFrame(() => { if (navmap && !navmap.fitted) { navmap.fit(); navmap.fitted = true; } });
  } else if (S.tab === "sim") {
    if (!sim) sim = new NavSim({ rid: S.rid, remote: r, doc: S.doc, start: S.sel, onPage: (p) => { S.sel = p; } });
    else sim.setDoc(S.doc, r);
    body.append(sim.root);
  } else {
    body.append(builderPane(r, Number.isInteger(S.sel) ? builderHash(S.sel) : ""));
  }
}

function identityLine(r) {
  const id = r.identity;
  if (!id) return null;
  const parts = [id.name, [id.manufacturer, id.model].filter(Boolean).join(" "), id.version && `app ${id.version}`].filter(Boolean);
  return el("div", {},
    el("div", { class: "muted", text: `📟 ${parts.join(" · ")}` }),
    r.duplicate_of && r.duplicate_of.length ? el("div", { class: "msg warn", text: "⚠ " + t("identity_duplicate", { names: r.duplicate_of.join(", ") }) }) : null);
}

/* ---------- start ---------- */
(async function start() {
  try {
    const [meta, hints] = await Promise.all([api("GET", "api/meta"), api("GET", `static/field_hints.json?v=${document.documentElement.dataset.version}`)]);
    S.hints = hints;
    if (meta.user) document.getElementById("user").textContent = meta.user;
    document.documentElement.lang = LANG;
    await loadList(false);
  } catch (e) { await handleError(e); }
})();
