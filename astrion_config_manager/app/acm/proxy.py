"""Reverse proxy to a remote's own web server (spec RF21.1, RF21.2).

The Astrion builder (``http://<remote>:8080/builder/``) is embedded in the
panel through ``proxy/<rid>/...``: Home Assistant serves the panel over
HTTPS (Ingress), so a plain-HTTP iframe would be blocked as mixed content.

The builder calls its server with ABSOLUTE paths (``fetch('/dashboard.json')``,
``<img src="/icons/...">``). Behind Ingress those would hit Home Assistant's
own root, so every HTML page served through the proxy gets a small script
(``SHIM``) injected first in ``<head>`` that:

- prefixes absolute same-origin paths in ``fetch()`` with the proxy base;
- fixes ``src`` / ``href`` / ``action`` attributes starting with ``/`` (static
  HTML is rewritten here, nodes added later by the builder are fixed by a
  MutationObserver);
- points ``window.opener`` to the panel (the iframe's parent), so the
  builder's own ``astrion-saved`` message (1.3.3-beta+, sent to
  ``window.opener`` after each save / restore) reaches the panel (RF21.1).

``acm-render.html`` (RF21.3) is served by the add-on itself under the proxied
``/builder/`` folder, so the builder's own scripts and ``i18n/`` load from the
remote with relative URLs: previews are drawn by the app version installed
on that remote.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

import aiohttp
from aiohttp import web

_LOGGER = logging.getLogger(__name__)

STATIC = Path(__file__).parent / "static"
TIMEOUT = aiohttp.ClientTimeout(total=60, sock_connect=5)

# Hop-by-hop / origin-specific headers not forwarded (RFC 9110 §7.6.1).
_SKIP_REQ = {
    "host",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "accept-encoding",
    "origin",
    "referer",
    "cookie",
    "authorization",
    "content-length",
}
_SKIP_RESP = {
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-encoding",
    "content-length",
    "content-security-policy",
    "x-frame-options",
    "set-cookie",
}

SHIM = """<script>/* ACM proxy shim (spec RF21.1) */
(function () {
  var m = location.pathname.match(/^(.*\\/proxy\\/[^/]+)(\\/|$)/);
  if (!m) return;
  var BASE = m[1];
  window.ACM_PROXY_BASE = BASE;
  function fix(u) {
    var abs = typeof u === "string" && u.charAt(0) === "/" && u.charAt(1) !== "/";
    return (abs && u.indexOf(BASE + "/") !== 0) ? BASE + u : u;
  }
  var f = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === "string") input = fix(input);
    else if (input && input.url && input.url.indexOf(location.origin + "/") === 0) {
      var p = input.url.slice(location.origin.length);
      if (p.indexOf(BASE + "/") !== 0) input = new Request(location.origin + BASE + p, input);
    }
    return f.call(this, input, init);
  };
  var ATTRS = ["src", "href", "action"];
  function fixEl(el) {
    if (!el || el.nodeType !== 1) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (v && v.charAt(0) === "/" && v.charAt(1) !== "/" && v.indexOf(BASE + "/") !== 0) {
        el.setAttribute(ATTRS[i], BASE + v);
      }
    }
  }
  function walk(n) {
    fixEl(n);
    if (!n.querySelectorAll) return;
    var l = n.querySelectorAll("[src],[href],[action]");
    for (var i = 0; i < l.length; i++) fixEl(l[i]);
  }
  new MutationObserver(function (ms) {
    ms.forEach(function (x) {
      if (x.type === "attributes") fixEl(x.target);
      else x.addedNodes.forEach(walk);
    });
  }).observe(document.documentElement,
    { subtree: true, childList: true, attributes: true, attributeFilter: ATTRS });
  // the builder posts "astrion-saved" to window.opener: here that is the panel
  try {
    if (window.parent !== window && !window.opener) window.opener = window.parent;
  } catch (e) { /* cross-origin */ }
})();
</script>"""

_ABS_ATTR = re.compile(r'(\s(?:src|href|action)=")/(?!/)')


def rewrite_html(html: str, base: str) -> str:
    """Prefix absolute attribute paths and inject the shim first in <head>."""
    html = _ABS_ATTR.sub(lambda m: f"{m.group(1)}{base}/", html)
    m = re.search(r"<head[^>]*>", html, re.I)
    if m:
        return html[: m.end()] + SHIM + html[m.end() :]
    return SHIM + html


async def forward(
    request: web.Request, session: aiohttp.ClientSession, host: str, port: int, tail: str
) -> web.StreamResponse:
    """Forward one request to ``http://host:port/<tail>`` and stream the answer."""
    # RF21.3: the add-on's own renderer page, inside the proxied /builder/ folder
    if tail == "builder/acm-render.html":
        html = (STATIC / "acm-render.html").read_text("utf-8")
        return web.Response(
            text=rewrite_html(html, _base(request, tail)),
            content_type="text/html",
            headers={"Cache-Control": "no-store"},
        )
    url = f"http://{host}:{port}/{tail}"
    headers = {
        k: v for k, v in request.headers.items() if k.lower() not in _SKIP_REQ and not k.lower().startswith("x-")
    }
    body = await request.read() if request.can_read_body else None
    _LOGGER.debug("proxy %s %s", request.method, url)
    try:
        async with session.request(
            request.method,
            url,
            params=request.query,
            data=body,
            headers=headers,
            allow_redirects=False,
            timeout=TIMEOUT,
        ) as resp:
            out_headers = {k: v for k, v in resp.headers.items() if k.lower() not in _SKIP_RESP}
            ctype = resp.headers.get("Content-Type", "")
            base = _base(request, tail)
            if "location" in {k.lower() for k in out_headers}:
                loc = resp.headers["Location"]
                if loc.startswith("/") and not loc.startswith("//"):
                    out_headers = {k: v for k, v in out_headers.items() if k.lower() != "location"}
                    out_headers["Location"] = base + loc
            if ctype.startswith("text/html"):
                text = (await resp.read()).decode("utf-8", "replace")
                out_headers.pop("Content-Type", None)
                return web.Response(
                    status=resp.status, text=rewrite_html(text, base), content_type="text/html", headers=out_headers
                )
            data = await resp.read()
            if request.method == "POST" and tail == "dashboard.json" and resp.status < 400:
                _LOGGER.info(
                    "Builder saved dashboard.json on %s:%s (version %s)",
                    host,
                    port,
                    resp.headers.get("X-Astrion-Version-Id") or "?",
                )
            return web.Response(status=resp.status, body=data, headers=out_headers)
    except (aiohttp.ClientError, TimeoutError) as err:
        _LOGGER.warning("proxy %s %s failed: %s", request.method, url, err or type(err).__name__)
        return web.json_response({"error": "unreachable", "detail": str(err) or type(err).__name__}, status=502)


def _base(request: web.Request, tail: str) -> str:
    """Path of ``proxy/<rid>`` as the browser sees it (Ingress prefix included)."""
    prefix = request.headers.get("X-Ingress-Path", "")
    rid = request.match_info["rid"]
    return f"{prefix}/proxy/{rid}"
