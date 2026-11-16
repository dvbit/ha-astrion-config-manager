"""Acceptance tests for 3.0 (spec RF21): live document, builder proxy, renderer page.

Reuses the fake remote of test_acceptance.py; the builder is emulated by a
small HTML page and a JSON endpoint with absolute paths.
"""

from __future__ import annotations

import copy
import json

from aiohttp import web

from tests.test_acceptance import BASE_DOC, register


def _with_builder(env):
    """Add a fake /builder/ (absolute paths, as the real one) to remote "a"."""
    srv = env.servers["a"]
    app = srv.app

    async def builder(_):
        html = (
            "<!doctype html><html><head><title>b</title></head>"
            '<body><img src="/icons/x.png"><a href="/builder/#history">h</a></body></html>'
        )
        return web.Response(text=html, content_type="text/html")

    async def js(_):
        return web.Response(text="console.log(1)", content_type="application/javascript")

    app.router._frozen = False  # test-only: add routes to the running fake
    app.router.add_get("/builder/", builder)
    app.router.add_get("/builder/js/x.js", js)
    app.router._frozen = True


# ------------------------------------------------------------------ RF21.5 live document


async def test_rf21_live_read_and_write_with_note(env):
    rid = (await register(env, "a", "Living"))["id"]
    live = await (await env.get(f"/api/remotes/{rid}/live")).json()
    assert live["doc"] == BASE_DOC and live["hash"]
    doc = copy.deepcopy(live["doc"])
    doc["pages"][0]["linkedPage"] = "Home"
    res = await env.put(f"/api/remotes/{rid}/live", json={"doc": doc, "hash": live["hash"], "note": "ACM: Home → Home"})
    assert res.status == 200, await res.text()
    out = await res.json()
    dev = env.devices["a"]
    assert json.loads(dev.text)["pages"][0]["linkedPage"] == "Home"
    assert dev.last_note == "ACM: Home → Home"
    assert out["doc"]["pages"][0]["linkedPage"] == "Home" and out["hash"] != live["hash"]


async def test_rf21_write_refused_when_remote_changed(env):
    rid = (await register(env, "a", "Living"))["id"]
    live = await (await env.get(f"/api/remotes/{rid}/live")).json()
    # the builder (or another panel) saves in the meantime
    changed = copy.deepcopy(BASE_DOC)
    changed["pages"][0]["name"] = "Casa"
    env.devices["a"].text = json.dumps(changed)
    doc = copy.deepcopy(live["doc"])
    doc["pages"][0]["parent"] = "X"
    res = await env.put(f"/api/remotes/{rid}/live", json={"doc": doc, "hash": live["hash"], "note": "ACM: x"})
    assert res.status == 409
    body = await res.json()
    assert body["error"] == "remote_changed" and body["doc"]["pages"][0]["name"] == "Casa"
    assert "parent" not in json.loads(env.devices["a"].text)["pages"][0]  # nothing written


async def test_rf21_versioning_routes_removed(env):
    rid = (await register(env, "a", "Living"))["id"]
    for method, url in (("GET", "state"), ("POST", "commit"), ("POST", "push"), ("POST", "undo"), ("GET", "drift")):
        resp = await env.request(method, f"/api/remotes/{rid}/{url}")
        assert resp.status in (404, 405), url


# ------------------------------------------------------------------ RF21.1 / RF21.3 proxy


async def test_rf21_proxy_rewrites_builder_html(env):
    _with_builder(env)
    rid = (await register(env, "a", "Living"))["id"]
    resp = await env.get(f"/proxy/{rid}/builder/", headers={"X-Ingress-Path": "/api/hassio_ingress/tok"})
    html = await resp.text()
    base = f"/api/hassio_ingress/tok/proxy/{rid}"
    assert resp.status == 200 and "ACM proxy shim" in html
    assert html.index("ACM proxy shim") < html.index("<title>")  # first in <head>
    assert f'src="{base}/icons/x.png"' in html and f'href="{base}/builder/#history"' in html
    js = await env.get(f"/proxy/{rid}/builder/js/x.js")
    assert js.status == 200 and await js.text() == "console.log(1)"


async def test_rf21_proxy_passes_dashboard_get_and_post(env):
    rid = (await register(env, "a", "Living"))["id"]
    got = await env.get(f"/proxy/{rid}/dashboard.json")
    assert json.loads(await got.text()) == BASE_DOC
    import aiohttp

    form = aiohttp.FormData()
    new = copy.deepcopy(BASE_DOC)
    new["pages"][0]["name"] = "FromBuilder"
    form.add_field("note", "builder save")
    form.add_field("file", json.dumps(new).encode(), filename="dashboard.json", content_type="application/json")
    resp = await env.post(f"/proxy/{rid}/dashboard.json", data=form, allow_redirects=False)
    assert resp.status in (302, 303)
    assert resp.headers["Location"].endswith(f"/proxy/{rid}/")  # redirect kept inside the proxy
    assert json.loads(env.devices["a"].text)["pages"][0]["name"] == "FromBuilder"
    assert env.devices["a"].last_note == "builder save"


async def test_rf21_render_page_served_inside_builder_folder(env):
    rid = (await register(env, "a", "Living"))["id"]
    resp = await env.get(f"/proxy/{rid}/builder/acm-render.html")
    html = await resp.text()
    assert resp.status == 200 and "window.ACM" in html and 'src="js/preview.js"' in html
    assert "ACM proxy shim" in html


async def test_rf21_proxy_unreachable_remote(env):
    rid = (await register(env, "a", "Living"))["id"]
    await env.servers["a"].close()
    resp = await env.get(f"/proxy/{rid}/builder/")
    assert resp.status == 502 and (await resp.json())["error"] == "unreachable"
