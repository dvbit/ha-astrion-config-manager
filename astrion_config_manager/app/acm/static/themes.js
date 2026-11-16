/* Theme library UI (spec RF14, RF21.6).
 *
 * - RF14.4  "Themes" tab: list with swatches, preview, rename, duplicate,
 *           delete, export .json, apply to several remotes, import from file
 *           (bad colours reported).
 * - RF21.6  3.0: applying writes the theme straight to each ticked remote
 *           (note "ACM: theme <name>"; the remote keeps the version). Previews
 *           are drawn by the chosen remote's own builder renderer (RF21.3).
 *           Editing a theme colour by colour is done in the builder.
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

/* RF14.5 / RF21.3: first page of `doc` drawn with `theme` by the remote's renderer. */
function themePreview(theme, doc, remote, rid) {
  const src = doc && Array.isArray(doc.pages) && doc.pages.length ? doc : THEME_SAMPLE_DOC;
  const themedDoc = { ...src, theme: theme || {} };
  const { w, h } = remoteSize(remote);
  const host = el("div", { class: "theme-preview", style: `width:${THEME_PREVIEW_W}px;height:${Math.round(h * THEME_PREVIEW_W / w)}px` });
  if (!rid) return host;
  if (!TH.renderer || TH.renderer.rid !== rid) { if (TH.renderer) TH.renderer.close(); TH.renderer = new Renderer(rid); }
  const r = TH.renderer;
  r.snapshot(themedDoc, 0, { w, h }).then((snap) => r.mount(host, snap, THEME_PREVIEW_W))
    .catch((e) => host.replaceChildren(el("p", { class: "muted", text: e.message })));
  return host;
}

function closeDialog(dlg) { dlg.close(); dlg.remove(); }

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

/* ---------- Themes tab (RF14.4) ---------- */

const TH = { previewRid: null, docs: {}, renderer: null };

async function previewDoc(rid) {
  if (!rid) return { doc: null, remote: null };
  if (!TH.docs[rid]) {
    const st = await api("GET", `api/remotes/${rid}/live`);
    TH.docs[rid] = { doc: st.doc, remote: st.remote };
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

/* RF14.4 / RF21.6 Apply to remotes: written straight to each ticked remote. */
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
        const msg = res.results.map((x) => `${x.name || x.id}: ${x.error ? t("err_" + x.error) : x.result === "written" ? t("written") : t("theme_unchanged")}`).join(" · ");
        closeDialog(dlg);
        TH.docs = {};
        toast(msg, res.results.some((x) => x.error));
      }) })));
  document.body.append(dlg);
  dlg.showModal();
}
