"""Isolated, local-only PVGIS transport probe for the Cloudflare Python Worker runtime.

This entrypoint is used only by the CI workflow with a dedicated Wrangler config.
It is not imported by the production API Worker.
"""
import asyncio
import json
from datetime import date

from fastapi import FastAPI
from js import AbortController, Object, Response, fetch
from pyodide.ffi import to_js
from workers import asgi

from services import pvgis, wapor

app = FastAPI(title="NOVA PVGIS Worker Runtime Test")


@app.get("/health")
async def health():
    return {"status": "ok"}


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


@app.get("/pvgis-global-fetch-binding")
async def pvgis_global_fetch_binding_probe():
    """Prove global js.fetch is callable without depending on external DNS."""
    controller = AbortController.new()
    options = to_js(
        {
            "method": "GET",
            "redirect": "error",
            "signal": controller.signal,
        },
        dict_converter=Object.fromEntries,
    )
    try:
        response = await asyncio.wait_for(
            fetch("https://nova-core-fetch-probe.invalid/", options),
            timeout=5,
        )
    except Exception as exc:
        error_name = pvgis._worker_js_error_name(exc)
        if not error_name:
            raise RuntimeError(
                "Global Fetch rejected without a safe JavaScript error class"
            ) from exc
        return {
            "status": "ok",
            "runtime": "cloudflare-python-worker-pyodide",
            "transport": "global-js-fetch",
            "fetch_callable": True,
            "expected_network_rejection": True,
            "js_error_class": error_name,
            "abort_signal_attached": options.signal is not None,
        }
    else:
        try:
            await response.body.cancel()
        except Exception:
            pass
        raise RuntimeError("Reserved .invalid probe unexpectedly resolved")


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



@app.get("/wapor-runtime")
async def wapor_runtime_probe():
    """Exercise bounded native Response streaming with a deterministic fixture."""
    controller = AbortController.new()
    expected = {
        "response": {
            "items": [{"code": "L1-AETI-D", "caption": "Global dekadal AETI"}],
            "links": [],
        }
    }
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

    payload = await wapor._fetch_worker_payload_with_abort(
        deterministic_fetch, wapor.BASE_URL, fetch_options, controller
    )
    if payload != expected or len(calls) != 1:
        raise RuntimeError("WaPOR Worker runtime fixture payload mismatch")
    result = wapor._discovery_result(
        {"items": payload["response"]["items"], "pages_read": 1, "truncated": False}
    )
    if result["mapsets"][0]["code"] != "L1-AETI-D":
        raise RuntimeError("WaPOR Worker runtime mapset metadata mismatch")
    return {
        "status": "ok",
        "runtime": "cloudflare-python-worker-pyodide",
        "native_response_stream": True,
        "abort_signal_attached": calls[0][1].signal is not None,
        "payload_verified": True,
    }


@app.get("/wapor-global-fetch-binding")
async def wapor_global_fetch_binding_probe():
    """Prove global js.fetch is callable without depending on external DNS."""
    controller = AbortController.new()
    options = to_js(
        {
            "method": "GET",
            "redirect": "error",
            "signal": controller.signal,
        },
        dict_converter=Object.fromEntries,
    )
    try:
        response = await asyncio.wait_for(
            fetch("https://nova-core-wapor-fetch-probe.invalid/", options),
            timeout=5,
        )
    except Exception as exc:
        error_name = pvgis._worker_js_error_name(exc)
        if not error_name:
            raise RuntimeError(
                "Global Fetch rejected without a safe JavaScript error class"
            ) from exc
        return {
            "status": "ok",
            "runtime": "cloudflare-python-worker-pyodide",
            "transport": "global-js-fetch",
            "fetch_callable": True,
            "expected_network_rejection": True,
            "js_error_class": error_name,
            "abort_signal_attached": options.signal is not None,
        }
    else:
        try:
            await response.body.cancel()
        except Exception:
            pass
        raise RuntimeError("Reserved .invalid WaPOR probe unexpectedly resolved")
