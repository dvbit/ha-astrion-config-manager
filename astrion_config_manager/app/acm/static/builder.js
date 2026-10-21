/* The remote's own builder (spec RF16.4 / RF16.5).
 *
 * - RF16.5 "Open in builder ↗": http://<ip>:<port>/builder/ in a NEW TAB via a
 *          real link (never window.open: blocked as a pop-up in HA's frame;
 *          never
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
 * - RF19.1 upstream 1.3.3-beta: after each "Save to device" / history restore
 *          the builder posts {type: "astrion-saved", versionId, reason} to
 *          window.opener (this page, opened with rel="opener"). Accepted only
 *          from the open remote's builder origin. Builder mode -> import now;
 *          otherwise -> drift re-check + banner, never an automatic import.
 *          Tab return / Done stay as fallbacks.
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

/* RF16.5 (2.15.1): the builder is opened by a REAL LINK (<a target="_blank">)
 * followed on the user's click. A script-opened tab (window.open) is treated
 * as a pop-up and blocked inside Home Assistant's frame and in the companion
 * app; a clicked link never is. rel="opener" keeps window.opener for a future
 * "saved" message from the builder. */
function builderLink(r, hashFn, label, cls, hint) {
  const off = remoteUnreachable(r.id);
  const why = off ? t("builder_unreachable", { host: `${r.host}:${r.port || 8080}` }) : null;
  if (off) return el("button", { class: cls, text: label, disabled: true, title: why });
  const a = el("a", { class: "button " + cls, href: builderBase(r) + hashFn(), target: "_blank", rel: "opener", title: hint, text: label });
  // the editor selection may have changed since this header was drawn
  a.addEventListener("pointerdown", () => { a.href = builderBase(S.remote) + hashFn(); });
  a.addEventListener("click", (e) => {
    a.href = builderBase(S.remote) + hashFn();
    if (!S.remote.native_builder) { NB.check = S.rid; return; } // follow the link; re-check drift on return
    if (S.nativeUnsynced) { // RF16.4: push / discard first, then a link to click
      e.preventDefault();
      nativePrepare(hashFn).catch(handleError);
      return;
    }
    NB.open = { rid: S.rid };
  });
  return a;
}
function builderButtons(r) {
  return [builderLink(r, builderHash, "🛠 " + t("builder_open") + " ↗", "builder-btn", t("builder_open_hint")),
    builderLink(r, () => "#history", "🕘 " + t("builder_history") + " ↗", "icon", t("builder_history_hint"))];
}

/* RF16.4: unsynced add-on changes -> Push / Discard; then a real link to click. */
async function nativePrepare(hashFn) {
  const choice = await nbChoice(t("nb_unsynced_title"), t("nb_unsynced_text"),
    [["push", "⬆ " + t("push")], ["discard", t("nb_discard")]]);
  if (!choice) return;
  if (choice === "push") {
    const res = await pushRemote(S.rid, S.remote.head);
    S.remote = res.remote;
  } else {
    applyResult(await api("POST", `api/remotes/${S.rid}/native/discard`, { head: S.remote.head }));
    toast(t("nb_discarded"));
  }
  S.nativeUnsynced = false;
  render();
  const dlg = el("dialog", { class: "navmap-dialog" }, el("h3", { text: t("nb_ready_title") }), el("p", { text: t("nb_ready_text") }));
  const close = () => { dlg.close(); dlg.remove(); };
  // the hash is computed now: a discard may have renamed the selected page
  const link = el("a", { class: "button primary", href: builderBase(S.remote) + hashFn(), target: "_blank", rel: "opener", text: "🛠 " + t("builder_open") + " ↗",
    onclick: () => { NB.open = { rid: S.rid }; setTimeout(close, 0); } });
  dlg.append(el("div", { class: "row" }, el("span", { class: "spacer" }), el("button", { text: t("cancel"), onclick: close }), link));
  document.body.append(dlg);
  dlg.showModal();
}

/* RF16.4: whether the add-on holds changes not sent to the remote (asked
 * before following the builder link; refreshed after every load/commit). */
async function refreshNativeUnsynced() {
  if (!S.remote || !S.remote.native_builder) { S.nativeUnsynced = false; return; }
  try {
    const st = await api("GET", `api/remotes/${S.rid}/native`);
    S.nativeUnsynced = !!st.unsynced;
  } catch (e) { S.nativeUnsynced = false; }
}

/* Back from the builder: the tab is visible again, or "Done" was pressed. */
async function nativeReturn(manual, saved) {
  if (S.view !== "remote" || (!manual && (!NB.open || NB.open.rid !== S.rid))) return;
  // one import at a time (message + tab return can arrive together)
  if (NB.busy) { NB.again = true; return; }
  NB.busy = true;
  try { await nativeReturnOnce(manual, saved); } finally { NB.busy = false; }
  if (NB.again) { NB.again = false; await nativeReturn(false); }
}
async function nativeReturnOnce(manual, saved) {
  const res = await api("POST", `api/remotes/${S.rid}/native/return`, { head: S.remote.head });
  if (res.status === "unchanged") {
    if (manual) toast(t("nb_no_changes"));
  } else if (res.status === "imported") {
    S.drift[S.rid] = "in_sync";
    applyResult(res);
    const o = res.version && res.version.origin;
    const why = saved ? ` · ${t("nb_saved_msg", { reason: saved.reason || "save" })}` : "";
    toast(res.version ? `${t("nb_imported", { v: res.version.id })}${o && o.note ? ` — ${o.note}` : ""}${why}` : t("nb_no_changes"));
  } else if (res.status === "conflict") {
    const choice = await nbChoice(t("nb_conflict_title"), t("nb_conflict_text"),
      [["remote", t("nb_keep_remote")], ["addon", t("nb_keep_addon")]]);
    if (choice === "remote") applyResult(await pullRemote(S.rid, S.remote.head));
    else if (choice === "addon" && confirmDriftPush(S.rid)) { const r2 = await pushRemote(S.rid, S.remote.head); S.remote = r2.remote; render(); }
  }
  if (manual) NB.open = null;
}
/* RF19.1 "astrion-saved" from the builder tab opened by this page. */
function driftRecheck(rid) {
  return api("GET", `api/remotes/${rid}/drift`).then((d) => {
    S.drift[rid] = d.status; S.driftChanges[rid] = d.changes; S.ignored.delete(rid); render();
    return d.status;
  });
}
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || typeof d !== "object" || d.type !== "astrion-saved") return;
  if (S.view !== "remote" || !S.remote) return;
  let origin = null;
  try { origin = new URL(builderBase(S.remote)).origin; } catch (err) { origin = null; }
  if (e.origin !== origin) { console.warn(`[acm] astrion-saved ignored: origin ${e.origin} is not ${origin}`); return; }
  const saved = { versionId: typeof d.versionId === "string" ? d.versionId : null, reason: d.reason === "restore" ? "restore" : "save" };
  console.info(`[acm] builder saved (${saved.reason}, version ${saved.versionId || "?"}) for '${S.remote.name}'`);
  if (S.remote.native_builder) {
    NB.open = NB.open && NB.open.rid === S.rid ? NB.open : { rid: S.rid };
    nativeReturn(false, saved).catch(handleError);
  } else {
    NB.check = null; // already re-checked here
    driftRecheck(S.rid).then((st) => { if (st === "drift") toast(t("nb_drift_msg")); }).catch((err) => console.error("[acm] drift re-check failed", err));
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (NB.open) nativeReturn(false).catch(handleError);
  else if (NB.check && NB.check === S.rid && S.view === "remote") {
    NB.check = null;
    driftRecheck(S.rid).catch(() => {});
  }
});

/* RF16.4 banner shown while the remote is in "Edit with the remote's builder" mode. */
function nativeBanner(r) {
  if (!r.native_builder) return null;
  return el("div", { class: "card banner row nb-banner" },
    el("div", {}, el("strong", { text: "🛠 " + t("nb_banner_title") }), el("div", { class: "muted", text: t("nb_banner_text") })),
    el("span", { class: "spacer" }),
    builderLink(r, builderHash, t("nb_edit") + " ↗", "primary", t("builder_open_hint")),
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
