/* The remote's own builder, embedded (spec RF21.1).
 *
 * 3.0: single-screen editing is done in the Astrion app's builder, shown full
 * screen in the "Builder" tab through the add-on proxy (proxy/<rid>/builder/),
 * so it works inside Home Assistant over HTTPS. Deep links (1.3.1-beta):
 * #page=<name>, #history, #hotkeys.
 * The builder posts {type: "astrion-saved", versionId, reason} to
 * window.opener after each save / restore (1.3.3-beta); the proxy shim makes
 * the panel its opener, so the map and the simulation reload at once. A
 * builder opened by hand in a new tab is caught on return (visibility).
 */
"use strict";

function builderUrl(rid, hash) { return `proxy/${rid}/builder/${hash || ""}`; }
function builderDirect(r, hash) { return `http://${r.host}:${r.port || 8080}/builder/${hash || ""}`; }

/* Deep link of the page selected on the map / shown by the simulation. */
function builderHash(p) {
  const page = (S.doc && S.doc.pages || [])[p];
  return page ? `#page=${encodeURIComponent(page.name || "")}` : "";
}

/* Builder tab body: the iframe + a fallback link in a new tab. */
function builderPane(r, hash) {
  const fr = el("iframe", { class: "builder-frame", src: builderUrl(r.id, hash), title: t("builder_tab"), allow: "clipboard-write" });
  const bar = el("div", { class: "row builder-bar" },
    el("span", { class: "muted", text: t("builder_embedded_hint") }), el("span", { class: "spacer" }),
    el("button", { class: "icon", text: "🕘 " + t("builder_history"), title: t("builder_history_hint"), onclick: () => { fr.src = builderUrl(r.id, "#history"); } }),
    el("button", { class: "icon", text: "⟳", title: t("builder_reload"), onclick: () => { fr.src = fr.src; } }),
    el("a", { class: "button icon", href: builderDirect(r, hash), target: "_blank", rel: "opener", title: t("builder_newtab_hint"),
      text: t("builder_newtab") + " ↗", onclick: () => { S.builderOut = true; } }));
  return el("div", { class: "builder-pane" }, bar, fr);
}

/* RF21.1: the builder saved -> reload the document (map, simulation). */
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || typeof d !== "object" || d.type !== "astrion-saved") return;
  const own = e.origin === location.origin;
  const direct = S.remote && e.origin === new URL(builderDirect(S.remote)).origin;
  if (!own && !direct) { console.warn(`[acm] astrion-saved ignored from ${e.origin}`); return; }
  if (S.view !== "remote") return;
  console.info(`[acm] builder saved (${d.reason === "restore" ? "restore" : "save"}, version ${d.versionId || "?"})`);
  reloadLive(t("builder_saved_reload", { reason: d.reason === "restore" ? t("builder_restore") : t("builder_save") })).catch(handleError);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !S.builderOut || S.view !== "remote") return;
  S.builderOut = false;
  reloadLive(null).catch(handleError);
});
