/* The remote's own builder (spec RF16.4 / RF16.5).
 *
 * - RF16.5 "Open in builder ↗": http://<ip>:<port>/builder/ in a NEW TAB (never
 *          an iframe: HA is served over HTTPS and the builder is plain HTTP on
 *          the local network), at the place selected in the editor
 *          (upstream 1.3.1-beta deep links: #page=<name>&card=<i>,
 *          #activity=<id>, #hotkeys, #history). Greyed out with the reason
 *          when the remote is unreachable.
 * - RF16.4 per-remote mode "Edit with the remote's builder": the remote is the
 *          editor, the add-on the backup. Before opening: unsynced add-on
 *          changes -> Push / Discard / Cancel. Back in this tab (tab visible
 *          again, or Done): pull; changes imported as a new version with the
 *          remote's history note; both sides changed -> the user chooses,
 *          never merged.
 */
"use strict";

const NB = { open: null }; // {rid, head} while a builder tab opened from here may be editing

function builderBase(r) { return `http://${r.host}:${r.port || 8080}/builder/`; }

/* Deep link of the editor's selection (1.3.1-beta). */
function builderHash() {
  const sel = editor && editor.sel;
  const pages = (S.doc && S.doc.pages) || [];
  if (!sel) return "";
  if ((sel.kind === "page" || sel.kind === "card") && pages[sel.p]) {
    const name = encodeURIComponent(pages[sel.p].name || "");
    return sel.kind === "card" ? `#page=${name}&card=${sel.c}` : `#page=${name}`;
  }
  if (sel.kind === "global" && (sel.g === "hotkeys" || sel.g === "longHotkeys")) return "#hotkeys";
  const m = sel.path && sel.path.match(/^\/activities\/(\d+)/);
  const act = m && (S.doc.activities || [])[+m[1]];
  if (act && act.id) return `#activity=${encodeURIComponent(act.id)}`;
  return "";
}

const remoteUnreachable = (rid) => S.drift[rid] === "unreachable";

/* Header buttons: Open in builder ↗ and History ↗ (disabled with a reason when unreachable). */
function builderButtons(r) {
  const off = remoteUnreachable(r.id);
  const why = off ? t("builder_unreachable", { host: `${r.host}:${r.port || 8080}` }) : null;
  return [
    el("button", { class: "builder-btn", text: "🛠 " + t("builder_open") + " ↗", disabled: off, title: why || t("builder_open_hint"),
      onclick: guard(() => openBuilder(builderHash())) }),
    el("button", { class: "icon", text: "🕘 " + t("builder_history") + " ↗", disabled: off, title: why || t("builder_history_hint"),
      onclick: guard(() => openBuilder("#history")) }),
  ];
}

/* RF16.4/16.5: the tab is opened synchronously (popup blockers), then pointed
 * at the builder once the native-mode checks are done (or closed on Cancel). */
async function openBuilder(hash) {
  const r = S.remote;
  const tab = window.open("", "_blank");
  if (!tab) return toast(t("builder_popup_blocked"), true);
  try {
    tab.document.title = t("builder_open");
    tab.document.body.textContent = t("loading");
  } catch (e) { /* cross-origin later: fine */ }
  if (r.native_builder) {
    const st = await api("GET", `api/remotes/${S.rid}/native`);
    if (st.unsynced) {
      const choice = await nbChoice(t("nb_unsynced_title"), t("nb_unsynced_text"),
        [["push", "⬆ " + t("push")], ["discard", t("nb_discard")]]);
      if (!choice) { tab.close(); return; }
      if (choice === "push") {
        try { const res = await pushRemote(S.rid, S.remote.head); S.remote = res.remote; } catch (e) { tab.close(); throw e; }
      } else {
        applyResult(await api("POST", `api/remotes/${S.rid}/native/discard`, { head: S.remote.head }));
        toast(t("nb_discarded"));
      }
    }
    NB.open = { rid: S.rid };
  } else {
    NB.check = S.rid; // not in native mode: only re-check drift when coming back
  }
  tab.location.href = builderBase(r) + hash;
  render();
}

/* Back from the builder: the tab is visible again, or "Done" was pressed. */
async function nativeReturn(manual) {
  if (S.view !== "remote" || (!manual && (!NB.open || NB.open.rid !== S.rid))) return;
  const res = await api("POST", `api/remotes/${S.rid}/native/return`, { head: S.remote.head });
  if (res.status === "unchanged") {
    if (manual) toast(t("nb_no_changes"));
  } else if (res.status === "imported") {
    S.drift[S.rid] = "in_sync";
    applyResult(res);
    const o = res.version && res.version.origin;
    toast(res.version ? `${t("nb_imported", { v: res.version.id })}${o && o.note ? ` — ${o.note}` : ""}` : t("nb_no_changes"));
  } else if (res.status === "conflict") {
    const choice = await nbChoice(t("nb_conflict_title"), t("nb_conflict_text"),
      [["remote", t("nb_keep_remote")], ["addon", t("nb_keep_addon")]]);
    if (choice === "remote") applyResult(await pullRemote(S.rid, S.remote.head));
    else if (choice === "addon" && confirmDriftPush(S.rid)) { const r2 = await pushRemote(S.rid, S.remote.head); S.remote = r2.remote; render(); }
  }
  if (manual) NB.open = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (NB.open) nativeReturn(false).catch(handleError);
  else if (NB.check && NB.check === S.rid && S.view === "remote") {
    NB.check = null;
    api("GET", `api/remotes/${S.rid}/drift`).then((d) => {
      S.drift[S.rid] = d.status; S.driftChanges[S.rid] = d.changes; S.ignored.delete(S.rid); render();
    }).catch(() => {});
  }
});

/* RF16.4 banner shown while the remote is in "Edit with the remote's builder" mode. */
function nativeBanner(r) {
  if (!r.native_builder) return null;
  const off = remoteUnreachable(r.id);
  return el("div", { class: "card banner row nb-banner" },
    el("div", {}, el("strong", { text: "🛠 " + t("nb_banner_title") }), el("div", { class: "muted", text: t("nb_banner_text") })),
    el("span", { class: "spacer" }),
    el("button", { class: "primary", text: t("nb_edit") + " ↗", disabled: off, title: off ? t("builder_unreachable", { host: `${r.host}:${r.port || 8080}` }) : null,
      onclick: guard(() => openBuilder(builderHash())) }),
    el("button", { text: "✓ " + t("nb_done"), onclick: guard(() => nativeReturn(true)) }),
    el("button", { text: t("nb_turn_off"), onclick: guard(async () => {
      await api("PATCH", `api/remotes/${r.id}`, { native_builder: false });
      NB.open = null;
      await loadRemote();
    }) }));
}

/* Small dialog with N choices + Cancel -> chosen key or null. */
function nbChoice(title, text, choices) {
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "navmap-dialog" }, el("h3", { text: title }), el("p", { text }));
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(el("div", { class: "row" }, el("span", { class: "spacer" }),
      el("button", { text: t("cancel"), onclick: () => done(null) }),
      ...choices.map(([k, label], i) => el("button", { class: i === 0 ? "primary" : "", text: label, onclick: () => done(k) }))));
    dlg.addEventListener("cancel", () => done(null));
    document.body.append(dlg);
    dlg.showModal();
  });
}
