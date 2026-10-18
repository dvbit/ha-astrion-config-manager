/* Theme library UI (spec RF14).
 *
 * - RF14.3  Editor -> Global -> Theme toolbar: Load (picker with swatches and
 *           preview; replaces the remote's "theme" block = one version, undoable),
 *           Save as (overwrite asks first), Delete (presets are read-only).
 * - RF14.4  "Themes" tab: list with swatches, preview, rename, duplicate,
 *           delete, export .json, apply to several remotes (one version each,
 *           nothing pushed), import from file (bad colours reported).
 * - RF14.5  preview before applying: the simulator's renderer draws the first
 *           page of the open (or chosen) remote with the theme applied.
 */
"use strict";

/* Sample page used for previews when no remote is available. */
const THEME_SAMPLE_DOC = {
  pages: [{ name: "Preview", cards: [
    { type: "title", options: { title: "Living room", subtitle: "Preview" } },
    { type: "scene_grid", options: { columns: 3, scenes: [{ name: "TV", icon: "mdi:television" }, { name: "Music", icon: "mdi:music" }, { name: "Off", icon: "mdi:power" }] } },
    { type: "light", options: { entity_id: "light.preview", name: "Ceiling" } },
  ] }],
};
const THEME_PREVIEW_W = 200;

/* Effective colours (saved values over the remote's defaults) for swatches. */
function themeColors(theme) {
  return { ...((S.hints && S.hints.theme) || {}), ...(theme || {}) };
}
function themeSwatches(theme) {
  const c = themeColors(theme);
  return el("span", { class: "theme-swatches" }, ...["background", "cardSurface", "controlBackground", "accent", "primaryText", "amber", "danger", "success"]
    .map((k) => el("span", { class: "theme-swatch", title: `${k} ${c[k] || ""}`, style: `background:${c[k] || "transparent"}` })));
}

/* RF14.5: first page of `doc` drawn with `theme`, scaled to THEME_PREVIEW_W. */
function themePreview(theme, doc, remote, rid) {
  const src = doc && Array.isArray(doc.pages) && doc.pages.length ? doc : THEME_SAMPLE_DOC;
  const themedDoc = { ...src, theme: theme || {} };
  const r = remote || { width: 480, height: 800, orientation: "portrait" };
  let w = r.width || 480, h = r.height || 800;
  if (((r.orientation || "portrait") === "portrait") !== (h >= w)) [w, h] = [h, w];
  const sim = new Simulator({ rid, remote: r, doc: themedDoc, preview: true });
  if (navmap && navmap.preview) sim.states = navmap.preview.states; // live states when the map has them
  const th = sim.theme();
  const scale = THEME_PREVIEW_W / w;
  const screen = el("div", { class: "sim-screen", style: `width:${w}px;height:${h}px;transform:scale(${scale});background:${th.background};color:${th.primaryText};--card:${th.cardSurface};--inset:${th.insetSurface};--ctl:${th.controlBackground};--muted:${th.mutedText};--acc:${th.accent};--amber:${th.amber};--danger:${th.danger};--ok:${th.success}` });
  try { screen.append(sim.renderPage(themedDoc.pages[0], 0, false)); } catch (e) { screen.append(el("p", { text: e.message })); }
  return el("div", { class: "theme-preview", style: `width:${THEME_PREVIEW_W}px;height:${Math.round(h * scale)}px` }, screen);
}

function closeDialog(dlg) { dlg.close(); dlg.remove(); }

/* RF14.3 Load: picker with swatches + live preview; resolves the chosen theme or null. */
function themePicker(doc, remote, rid) {
  return new Promise((resolve) => {
    (async () => {
      const list = await api("GET", "api/themes");
      const dlg = el("dialog", { class: "theme-dialog" });
      const prev = el("div", {});
      let chosen = null;
      const items = list.map((th) => {
        const b = el("button", { class: "theme-item" }, el("strong", { text: th.name }), th.preset ? el("span", { class: "badge", text: t("theme_preset") }) : null, themeSwatches(th.theme));
        b.onclick = () => {
          chosen = th;
          dlg.querySelectorAll(".theme-item").forEach((x) => x.classList.toggle("sel", x === b));
          prev.replaceChildren(themePreview(th.theme, doc, remote, rid));
          load.disabled = false;
        };
        return b;
      });
      const load = el("button", { class: "primary", text: t("theme_load"), disabled: true, onclick: () => { closeDialog(dlg); resolve(chosen); } });
      dlg.append(el("h2", { text: t("theme_load") }),
        el("div", { class: "theme-pick" }, el("div", { class: "theme-list" }, ...items), prev),
        el("p", { class: "muted", text: t("theme_load_hint") }),
        el("div", { class: "row" }, el("span", { class: "spacer" }),
          el("button", { text: t("cancel"), onclick: () => { closeDialog(dlg); resolve(null); } }), load));
      document.body.append(dlg);
      dlg.showModal();
    })().catch(async (e) => { await handleError(e); resolve(null); });
  });
}

/* RF14.3 Save as: asks a name; on a clash with a saved theme asks to overwrite. */
async function themeSaveAs(theme, suggested) {
  const name = prompt(t("theme_name_prompt"), suggested || "");
  if (name === null || !name.trim()) return null;
  try {
    const res = await api("POST", "api/themes", { name, theme });
    toast(`${t("theme_saved")}: ${res.name}`);
    return res;
  } catch (e) {
    if (e.data && e.data.error === "theme_name_exists" && !e.data.preset) {
      if (!confirm(t("theme_overwrite_confirm", { name }))) return null;
      const res = await api("POST", "api/themes", { name, theme, overwrite: true });
      toast(`${t("theme_saved")}: ${res.name}`);
      return res;
    }
    throw e;
  }
}

/* RF14.3 Delete from the editor: pick one saved theme. */
async function themeDeleteDialog() {
  const list = (await api("GET", "api/themes")).filter((x) => !x.preset);
  if (!list.length) return toast(t("theme_none_saved"));
  const sel = el("select", {}, ...list.map((x) => el("option", { value: x.id, text: x.name })));
  const dlg = el("dialog", {}, el("h3", { text: t("theme_delete") }), sel,
    el("div", { class: "row" }, el("span", { class: "spacer" }),
      el("button", { text: t("cancel"), onclick: () => closeDialog(dlg) }),
      el("button", { class: "danger", text: t("delete"), onclick: guard(async () => {
        const th = list.find((x) => x.id === sel.value);
        if (!confirm(t("theme_delete_confirm", { name: th.name }))) return;
        await api("DELETE", `api/themes/${encodeURIComponent(th.id)}`);
        closeDialog(dlg); toast(t("theme_deleted"));
      }) })));
  document.body.append(dlg);
  dlg.showModal();
}

/* Toolbar shown above the theme colours in Editor -> Global -> Theme. */
function themeToolbar(editor) {
  return el("div", { class: "row theme-toolbar" },
    el("button", { text: "📂 " + t("theme_load"), onclick: guard(async () => {
      const th = await themePicker(editor.doc, S.remote, S.rid);
      if (!th) return;
      // one version, undoable (RF2.3); empty block = the remote's own defaults
      await editor.change((d) => { if (Object.keys(th.theme).length) d.theme = clone(th.theme); else delete d.theme; });
      toast(`${t("theme_loaded")}: ${th.name}`);
    }) }),
    el("button", { text: "💾 " + t("theme_save_as"), onclick: guard(() => themeSaveAs((editor.doc && editor.doc.theme) || {}, "")) }),
    el("button", { class: "danger", text: "🗑 " + t("theme_delete"), onclick: guard(themeDeleteDialog) }));
}

/* ---------- Themes tab (RF14.4) ---------- */

const TH = { previewRid: null, docs: {} };

async function previewDoc(rid) {
  if (!rid) return { doc: null, remote: null };
  if (!TH.docs[rid]) {
    const st = await api("GET", `api/remotes/${rid}/state`);
    TH.docs[rid] = { doc: st.state, remote: st.remote };
  }
  return TH.docs[rid];
}

async function renderThemes() {
  const box = el("div", { class: "card" }, el("p", { class: "muted", text: t("themes_hint") }));
  main.append(box);
  const [list, remotes] = await Promise.all([api("GET", "api/themes"), api("GET", "api/remotes")]);
  if (TH.previewRid === null && remotes.length) TH.previewRid = remotes[0].id;
  const pv = await previewDoc(TH.previewRid);
  // import from file
  const file = el("input", { type: "file", accept: "application/json,.json" });
  file.onchange = guard(async () => {
    const f = file.files[0];
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch (e) { return toast(`${t("invalid_json")}: ${e.message}`, true); }
    let name = null;
    for (;;) {
      try {
        const res = await api("POST", "api/themes/import", name ? { data, name } : { data });
        toast(`${t("theme_imported")}: ${res.name}` + (res.rejected.length ? ` · ${t("theme_rejected", { list: res.rejected.map((r) => r.key).join(", ") })}` : ""), res.rejected.length > 0);
        break;
      } catch (e) {
        if (!(e.data && e.data.error === "theme_name_exists")) throw e;
        name = prompt(t("theme_name_clash"), (name || (data && data.name) || "") + " (2)");
        if (name === null) return;
      }
    }
    file.value = ""; render();
  });
  const pvSel = el("select", {}, ...remotes.map((r) => el("option", { value: r.id, text: r.name, selected: r.id === TH.previewRid })));
  pvSel.onchange = () => { TH.previewRid = pvSel.value; render(); };
  box.append(el("div", { class: "row" }, el("label", { class: "row" }, el("span", { text: t("theme_import") }), file),
    el("span", { class: "spacer" }), remotes.length ? el("label", { class: "row" }, el("span", { text: t("theme_preview_with") }), pvSel) : null));
  const grid = el("div", { class: "theme-grid" });
  for (const th of list) {
    const actions = el("div", { class: "row" },
      el("button", { class: "icon", text: t("theme_apply"), onclick: guard(() => themeApplyDialog(th, remotes)) }),
      el("button", { class: "icon", text: t("duplicate"), onclick: guard(async () => { await themeSaveAs(th.theme, `${th.name} (2)`); render(); }) }),
      el("a", { class: "button icon", href: `api/themes/${encodeURIComponent(th.id)}/export`, download: "", text: t("theme_export") }),
      th.preset ? null : el("button", { class: "icon", text: t("theme_rename"), onclick: guard(async () => {
        const name = prompt(t("theme_name_prompt"), th.name);
        if (name === null || name === th.name) return;
        await api("PUT", `api/themes/${encodeURIComponent(th.id)}`, { name }); render();
      }) }),
      th.preset ? null : el("button", { class: "icon danger", text: t("delete"), onclick: guard(async () => {
        if (!confirm(t("theme_delete_confirm", { name: th.name }))) return;
        await api("DELETE", `api/themes/${encodeURIComponent(th.id)}`); toast(t("theme_deleted")); render();
      }) }));
    grid.append(el("div", { class: "card theme-card" },
      el("div", { class: "row" }, el("strong", { text: th.name }), th.preset ? el("span", { class: "badge", text: t("theme_preset") }) : null),
      themeSwatches(th.theme), themePreview(th.theme, pv.doc, pv.remote, TH.previewRid), actions));
  }
  box.append(grid);
}

/* RF14.4 Apply to remotes: one version per ticked remote, nothing pushed. */
function themeApplyDialog(th, remotes) {
  if (!remotes.length) return toast(t("empty_list"));
  const rows = remotes.map((r) => ({ r, cb: el("input", { type: "checkbox" }) }));
  const dlg = el("dialog", {}, el("h3", { text: `${t("theme_apply")}: ${th.name}` }), el("p", { class: "muted", text: t("theme_apply_hint") }),
    ...rows.map(({ r, cb }) => el("label", { class: "row" }, cb, el("span", { text: r.name }))),
    el("div", { class: "row" }, el("span", { class: "spacer" }),
      el("button", { text: t("cancel"), onclick: () => closeDialog(dlg) }),
      el("button", { class: "primary", text: t("theme_apply"), onclick: guard(async () => {
        const ids = rows.filter((x) => x.cb.checked).map((x) => x.r.id);
        if (!ids.length) return;
        const res = await api("POST", `api/themes/${encodeURIComponent(th.id)}/apply`, { remotes: ids });
        const msg = res.results.map((x) => `${x.name || x.id}: ${x.error ? t("err_" + x.error) : x.version ? "v" + x.version : t("theme_unchanged")}`).join(" · ");
        closeDialog(dlg);
        TH.docs = {};
        toast(msg, res.results.some((x) => x.error));
      }) })));
  document.body.append(dlg);
  dlg.showModal();
}
