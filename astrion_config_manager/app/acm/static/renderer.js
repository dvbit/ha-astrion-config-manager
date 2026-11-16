/* Screens drawn by the remote's own builder renderer (spec RF21.3).
 *
 * The add-on no longer draws cards itself: proxy/<rid>/builder/acm-render.html
 * loads the builder's preview code from the remote (so it always matches the
 * installed app version, every card type included) and exposes window.ACM.
 *
 * - Renderer.snapshot(): one hidden renderer per remote draws a page and the
 *   map gets a static copy (HTML + the builder's styles in a shadow root):
 *   cheap to redraw, no iframe per screen.
 * - acmTiles(): grid items of a drawn page -> JSON pointers (same rules as
 *   ACM.tiles() in acm-render.html), used for tile links and the simulation.
 */
"use strict";

const DP_DENSITY = 220 / 160; // HA100: 480x800 px -> 349x582 dp (builder styles.css)

function renderUrl(rid) { return `proxy/${rid}/builder/acm-render.html`; }

/* Grid items under `root` (a drawn page) in DOM order -> [{path, el, nested}]. */
function acmTiles(root, page, p) {
  const out = [];
  const base = `/pages/${p}/cards`;
  root.querySelectorAll("[data-card-idx]").forEach((cardEl) => {
    const ci = +cardEl.dataset.cardIdx;
    const card = ((page && page.cards) || [])[ci] || {};
    const o = card.options || {};
    const lk = { button_grid: "buttons", scene_grid: "scenes" }[card.type];
    if (lk) {
      cardEl.querySelectorAll(".preview-button-tile, .preview-scene-tile").forEach((elx, k) => {
        if (k < (o[lk] || []).length) out.push({ path: `${base}/${ci}/options/${lk}/${k}`, el: elx });
      });
    } else if (card.type === "row") {
      // the builder draws a row's cards as placeholders: one entry per nested card
      cardEl.querySelectorAll(":scope > div:last-child > div").forEach((elx, j) => {
        if ((o.cards || [])[j]) out.push({ path: `${base}/${ci}/options/cards/${j}`, el: elx, nested: true });
      });
    }
  });
  return out;
}

class Renderer {
  constructor(rid) {
    this.rid = rid;
    this.queue = Promise.resolve();
    this.frame = el("iframe", { class: "acm-renderer", src: renderUrl(rid), tabindex: "-1", "aria-hidden": "true", title: "renderer" });
    this.loaded = new Promise((resolve, reject) => {
      this.frame.addEventListener("load", () => {
        const w = this.frame.contentWindow;
        if (!w || !w.ACM) { reject(new Error(t("render_unavailable"))); return; }
        w.ACM.ready.then(() => resolve(w)).catch(reject);
      });
      this.frame.addEventListener("error", () => reject(new Error(t("render_unavailable"))));
    });
    this.loaded.catch((err) => console.error("[acm] renderer not available:", err));
    document.body.append(this.frame);
    this.css = `proxy/${rid}/builder/styles.css`;
  }
  close() { this.frame.remove(); }

  /* Draw page p and return a static copy; renders are serialized. */
  snapshot(doc, p, opts) {
    const job = this.queue.then(async () => {
      const w = await this.loaded;
      const res = w.ACM.render(doc, p, opts);
      if (res && res.errors && res.errors.length) console.warn(`[acm] renderer page ${p}:`, res.errors.join(" | "));
      const screen = w.document.querySelector(".remote-screen");
      const scaler = w.document.querySelector(".remote-screen-scaler");
      return {
        vars: screen.getAttribute("style") || "",
        width: scaler.style.width, height: scaler.style.height,
        html: scaler.innerHTML,
        popup: !!(opts && opts.popup),
      };
    });
    this.queue = job.catch(() => {});
    return job;
  }

  /* Put a snapshot in `host` (shadow root: the builder's CSS stays inside). */
  mount(host, snap, widthPx) {
    const root = host.shadowRoot || host.attachShadow({ mode: "open" });
    const dpW = parseFloat(snap.width) || 349;
    const k = widthPx / dpW;
    root.innerHTML = "";
    root.append(
      el("link", { rel: "stylesheet", href: this.css }),
      el("style", { text: `:host{display:block;overflow:hidden;background:#000}
        .remote-screen{width:100%!important;height:100%!important;border:0!important;border-radius:0!important;cursor:inherit!important}
        .remote-screen-scaler{transform-origin:top left}
        .ha-draggable-card>.card>.card-title,.card.ha-draggable-card>.card-title,.preview-add-fab,.remove{display:none!important}
        ${snap.popup ? ".remote-status-bar{display:none}" : ""}` }),
      (() => {
        const scr = el("div", { class: "remote-screen", style: snap.vars });
        const sc = el("div", { class: "remote-screen-scaler", style: `width:${snap.width};height:${snap.height};transform:scale(${k})` });
        sc.innerHTML = snap.html;
        scr.append(sc);
        return scr;
      })());
    return root;
  }
}
