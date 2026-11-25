"""Isolated, local-only PVGIS transport probe for the Cloudflare Python Worker runtime.

This entrypoint is used only by the CI workflow with a dedicated Wrangler config.
It is not imported by the production API Worker.
"""
import json
from datetime import date

from fastapi import FastAPI
from js import AbortController, Object, Response
from pyodide.ffi import to_js
from workers import asgi

from services import pvgis

app = FastAPI(title="NOVA PVGIS Worker Runtime Test")


@app.get("/pvgis-runtime")
async def pvgis_runtime_probe():
    controller = AbortController.new()
    expected = {"outputs": {"totals": {"fixed": 1}}}
    response_init = to_js(
        {"headers": {"content-type": "application/json"}},
        dict_converter=Object.fromEntries,
    )
    native_response = Response.new(json.dumps(expected), response_init)
    fetch_options = to_js(
        {
            "method": "GET",
            "headers": {"Accept": "application/json"},
            "redirect": "error",
            "signal": controller.signal,
        },
        dict_converter=Object.fromEntries,
    )
    calls = []

    async def deterministic_fetch(url, options):
        calls.append((url, options))
        return native_response

    payload = await pvgis._fetch_worker_payload_with_abort(
        deterministic_fetch,
        "https://pvgis-runtime-fixture.invalid/seriescalc",
        fetch_options,
        controller,
    )
    if payload != expected:
        raise RuntimeError("PVGIS Worker runtime fixture payload mismatch")
    if len(calls) != 1:
        raise RuntimeError("PVGIS Worker runtime fixture fetch count mismatch")
    if calls[0][1].signal.aborted:
        raise RuntimeError("PVGIS Worker runtime fixture unexpectedly aborted")

    return {
        "status": "ok",
        "runtime": "cloudflare-python-worker-pyodide",
        "native_response_stream": True,
        "abort_signal_attached": calls[0][1].signal is not None,
        "payload_verified": True,
    }


@app.get("/pvgis-global-fetch")
async def pvgis_global_fetch_probe():
    """Exercise the real Workers global js.fetch path against the live PVGIS API."""
    payload = await pvgis.fetch_broadband_performance_async(
        36.8, 10.2, date(2024, 1, 1), date(2024, 1, 7)
    )
    return {
        "status": "ok",
        "runtime": "cloudflare-python-worker-pyodide",
        "transport": "global-js-fetch",
        "payload_verified": isinstance(payload, dict) and bool(payload),
        "payload_keys": sorted(payload.keys()),
    }


Default = asgi.entrypoint(app)
