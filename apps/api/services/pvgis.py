"""PVGIS 6 research connector.

PVGIS results are model-derived estimates, never field meter observations.
The connector is intentionally read-only and does not persist or register a site.
"""
from __future__ import annotations

import asyncio
import json
import math
from datetime import date
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

PVGIS_PERFORMANCE_URL = (
    "https://photovoltaic-geographical-information-system.ec.europa.eu"
    "/api/v6/performance/broadband"
)
PVGIS_MIN_YEAR = 2014
PVGIS_MAX_YEAR = 2025
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
TIMEOUT_SECONDS = 20


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_request(
    latitude: float, longitude: float, start_date: date, end_date: date
) -> None:
    if not math.isfinite(latitude) or not -90 <= latitude <= 90:
        raise ValueError("latitude must be finite and between -90 and 90")
    if not math.isfinite(longitude) or not -180 <= longitude <= 180:
        raise ValueError("longitude must be finite and between -180 and 180")
    if end_date < start_date:
        raise ValueError("end_date must be on or after start_date")
    if start_date.year < PVGIS_MIN_YEAR or end_date.year > PVGIS_MAX_YEAR:
        raise ValueError("PVGIS 6 time series is limited to calendar years 2014-2025")
    if (end_date - start_date).days > 366:
        raise ValueError("PVGIS research request cannot exceed 367 calendar days")


def _is_json_content_type(value: Any) -> bool:
    """Accept JSON media types, including vendor +json types, not substring lookalikes."""
    media_type = str(value or "").split(";", 1)[0].strip().lower()
    if "/" not in media_type:
        return False
    _type, subtype = media_type.split("/", 1)
    return _type == "application" and (
        subtype == "json" or subtype.endswith("+json")
    )


def parse_response(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or not payload:
        raise ValueError("PVGIS returned an empty or invalid JSON object")
    if payload.get("status") == "error" or payload.get("error"):
        raise ValueError("PVGIS returned a provider error response")
    return payload


async def _read_bounded_response(response: Any) -> bytes:
    """Read a Workers Fetch body incrementally and cancel as soon as it exceeds the cap."""
    body = getattr(response, "body", None)
    if body is None:
        raise RuntimeError("PVGIS response did not expose a readable body")
    reader = body.getReader()
    chunks: list[bytes] = []
    total = 0
    try:
        while True:
            result = await reader.read()
            if result.done:
                break
            # Inspect the JavaScript TypedArray before Pyodide converts it.
            # to_py() can allocate/copy the complete chunk, so it must only run
            # after the cumulative response budget has been checked.
            chunk_view = result.value
            chunk_size = int(chunk_view.byteLength)
            if total + chunk_size > MAX_RESPONSE_BYTES:
                raise RuntimeError("PVGIS response exceeded the 2 MiB limit")
            chunk = bytes(chunk_view.to_py())
            if len(chunk) != chunk_size:
                raise RuntimeError("PVGIS response chunk length changed during conversion")
            total += chunk_size
            chunks.append(chunk)
    except BaseException:
        try:
            await reader.cancel()
        except BaseException:
            pass
        raise
    finally:
        try:
            reader.releaseLock()
        except Exception:
            pass
    return b"".join(chunks)


def fetch_broadband_performance(
    latitude: float, longitude: float, start_date: date, end_date: date
) -> dict[str, Any]:
    validate_request(latitude, longitude, start_date, end_date)
    query = urlencode(
        {
            "latitude": latitude,
            "longitude": longitude,
            "start_time": f"{start_date.isoformat()} 00:00:00",
            "end_time": f"{end_date.isoformat()} 23:59:59",
        }
    )
    request = Request(
        f"{PVGIS_PERFORMANCE_URL}?{query}",
        headers={
            "Accept": "application/json",
            "User-Agent": "NOVA-Core-Research/0.1 (NeoHaven Urban Labs)",
        },
        method="GET",
    )
    opener = build_opener(_RejectRedirects())
    try:
        with opener.open(request, timeout=TIMEOUT_SECONDS) as response:
            content_type = response.headers.get("Content-Type", "")
            if not _is_json_content_type(content_type):
                raise RuntimeError("PVGIS returned a non-JSON content type")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise RuntimeError("PVGIS response exceeded the 2 MiB limit")
            payload = json.loads(raw.decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"PVGIS request failed with HTTP {exc.code}") from exc
    except (URLError, TimeoutError) as exc:
        raise RuntimeError("PVGIS request failed or timed out") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("PVGIS returned invalid JSON") from exc

    return parse_response(payload)


async def _cancel_worker_response_body(response: Any) -> None:
    """Cancel an unconsumed Workers Fetch body when response validation fails."""
    body = getattr(response, "body", None)
    cancel = getattr(body, "cancel", None)
    if not callable(cancel):
        return
    try:
        await cancel()
    except Exception:
        # Preserve the original HTTP/header validation error.
        pass


def _worker_js_error_name(exc: BaseException) -> str | None:
    """Return only a safe JavaScript error class; never expose provider URLs or messages."""
    candidates = (
        getattr(exc, "name", None),
        getattr(getattr(exc, "js_error", None), "name", None),
    )
    for candidate in candidates:
        if (
            isinstance(candidate, str)
            and candidate.isidentifier()
            and len(candidate) <= 40
        ):
            return candidate
    return None


async def _fetch_worker_payload(fetch: Any, url: str, options: Any) -> dict[str, Any]:
    """Fetch and consume one bounded response under the caller's total deadline."""
    try:
        response = await fetch(url, options)
    except Exception as exc:
        js_name = _worker_js_error_name(exc)
        diagnostic = f"; JS error={js_name}" if js_name else ""
        raise RuntimeError(f"PVGIS upstream Fetch rejected{diagnostic}") from exc
    if not response.ok:
        await _cancel_worker_response_body(response)
        raise RuntimeError(f"PVGIS request failed with HTTP {response.status}")
    content_type = str(response.headers.get("content-type") or "")
    if not _is_json_content_type(content_type):
        await _cancel_worker_response_body(response)
        raise RuntimeError("PVGIS returned a non-JSON content type")
    raw = await _read_bounded_response(response)
    return json.loads(raw.decode("utf-8"))


async def _fetch_worker_payload_with_abort(
    fetch: Any, url: str, options: Any, controller: Any
) -> dict[str, Any]:
    """Abort the upstream Fetch before awaiting potentially slow stream cleanup."""
    task = asyncio.create_task(_fetch_worker_payload(fetch, url, options))
    try:
        return await asyncio.shield(task)
    except BaseException:
        try:
            controller.abort()
        except BaseException:
            pass
        task.cancel()
        try:
            await task
        except BaseException:
            pass
        raise


async def fetch_broadband_performance_async(
    latitude: float, longitude: float, start_date: date, end_date: date
) -> dict[str, Any]:
    """Use bounded Workers streaming in Pyodide and bounded urllib locally."""
    validate_request(latitude, longitude, start_date, end_date)
    try:
        from js import AbortController, Object, fetch
        from pyodide.ffi import to_js
    except ImportError:
        return await asyncio.to_thread(
            fetch_broadband_performance,
            latitude,
            longitude,
            start_date,
            end_date,
        )

    query = urlencode(
        {
            "latitude": latitude,
            "longitude": longitude,
            "start_time": f"{start_date.isoformat()} 00:00:00",
            "end_time": f"{end_date.isoformat()} 23:59:59",
        }
    )
    url = f"{PVGIS_PERFORMANCE_URL}?{query}"
    controller = AbortController.new()
    options = to_js(
        {
            "method": "GET",
            "headers": {"Accept": "application/json"},
            "redirect": "error",
            "signal": controller.signal,
        },
        dict_converter=Object.fromEntries,
    )
    try:
        payload = await asyncio.wait_for(
            _fetch_worker_payload_with_abort(fetch, url, options, controller),
            timeout=TIMEOUT_SECONDS,
        )
    except RuntimeError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("PVGIS returned invalid JSON") from exc
    except Exception as exc:
        # Keep the provider failure message sanitized while preserving the
        # exception class for runtime diagnostics (without logging request data).
        raise RuntimeError(
            f"PVGIS request failed or timed out ({type(exc).__name__})"
        ) from exc
    return parse_response(payload)


def build_research_result(
    payload: dict[str, Any],
    latitude: float,
    longitude: float,
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    """Wrap raw provider output with explicit model provenance and request context."""
    return {
        "status": "retrieved",
        "dataset_id": "jrc-pvgis-6",
        "provider": "European Commission Joint Research Centre (JRC)",
        "evidence_class": "gridded_model_product",
        "interpretation": "PVGIS model-derived solar/PV performance estimate; not measured inverter output, a field observation, or a validated site baseline.",
        "provider_endpoint": PVGIS_PERFORMANCE_URL,
        "provider_version": "PVGIS API v6 beta",
        "attribution": "European Commission Joint Research Centre (JRC), PVGIS",
        "attribution_url": "https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-6/using-pvgis_en",
        "request": {
            "latitude": latitude,
            "longitude": longitude,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
        },
        "data": payload,
        "limitations": [
            "PVGIS 6 is a beta service and its API may change.",
            "The returned values are model outputs, not measurements from a physical PV installation.",
            "No pilot site, asset, meter, or customer record is created by this request.",
            "No result is persisted; retrieval alone does not establish validation or operational readiness.",
        ],
    }
