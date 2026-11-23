from __future__ import annotations

import asyncio
import json
from datetime import date
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

NASA_POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
NASA_POWER_PARAMETERS = (
    "T2M,T2M_MAX,T2M_MIN,RH2M,PRECTOTCORR,WS10M,ALLSKY_SFC_SW_DWN"
)
NASA_POWER_TIMEOUT_SECONDS = 20
NASA_POWER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class _RejectRedirects(HTTPRedirectHandler):
    """Prevent urllib from following provider redirects."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _read_bounded_response(response: Any) -> bytes:
    raw = response.read(NASA_POWER_MAX_RESPONSE_BYTES + 1)
    if len(raw) > NASA_POWER_MAX_RESPONSE_BYTES:
        raise RuntimeError("NASA POWER response exceeded the 2 MiB limit")
    return raw


def _decode_json_response(raw: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("NASA POWER returned an invalid JSON response") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("NASA POWER returned an invalid JSON object")
    return payload


def parse_daily_response(payload: dict[str, Any]) -> dict[str, Any]:
    properties = payload.get("properties") or {}
    parameter_data = properties.get("parameter") or {}
    if not parameter_data:
        raise ValueError("NASA POWER response did not contain daily parameter data")

    header = payload.get("header") or {}
    parameter_metadata = payload.get("parameters") or {}
    fill_value = header.get("fill_value", -999)
    units = {
        name: metadata.get("units")
        for name, metadata in parameter_metadata.items()
        if isinstance(metadata, dict)
    }
    dates = sorted({day for values in parameter_data.values() for day in values})
    records = []
    for day in dates:
        values: dict[str, float | None] = {}
        for name, series in parameter_data.items():
            value = series.get(day)
            values[name] = None if value is None or value == fill_value else value
        records.append({"date": day, "values": values})

    return {
        "records": records,
        "units": units,
        "source_metadata": {
            "title": header.get("title"),
            "sources": header.get("sources", []),
            "time_standard": header.get("time_standard", "LST"),
            "latitude": header.get("latitude"),
            "longitude": header.get("longitude"),
            "fill_value": fill_value,
        },
    }


def _worker_fetch_options(to_js: Any, object_from_entries: Any) -> Any:
    """Build Fetch options with redirect handling explicit and testable."""
    return to_js(
        {"method": "GET", "headers": {"Accept": "application/json"}, "redirect": "error"},
        dict_converter=object_from_entries,
    )


def _request_url(latitude: float, longitude: float, start_date: date, end_date: date) -> str:
    query = {
        "parameters": NASA_POWER_PARAMETERS,
        "community": "AG",
        "longitude": longitude,
        "latitude": latitude,
        "start": start_date.strftime("%Y%m%d"),
        "end": end_date.strftime("%Y%m%d"),
        "format": "JSON",
        "time-standard": "UTC",
    }
    return f"{NASA_POWER_URL}?{urlencode(query)}"


def fetch_daily_point(
    latitude: float, longitude: float, start_date: date, end_date: date
) -> dict[str, Any]:
    request = Request(
        _request_url(latitude, longitude, start_date, end_date),
        headers={
            "User-Agent": "NOVA-Core/0.2 (NeoHaven Urban Labs)",
            "Accept": "application/json",
        },
    )
    try:
        opener = build_opener(_RejectRedirects())
        with opener.open(request, timeout=NASA_POWER_TIMEOUT_SECONDS) as response:
            payload = _decode_json_response(_read_bounded_response(response))
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError(f"NASA POWER request failed: {exc}") from exc
    return parse_daily_response(payload)


async def _read_worker_body(response: Any) -> bytes:
    """Consume a Fetch ReadableStream incrementally with a hard byte ceiling."""
    reader = response.body.getReader()
    chunks: list[bytes] = []
    total = 0
    try:
        while True:
            item = await reader.read()
            if item.done:
                break
            chunk = bytes(item.value.to_py())
            total += len(chunk)
            if total > NASA_POWER_MAX_RESPONSE_BYTES:
                await reader.cancel()
                raise RuntimeError("NASA POWER response exceeded the 2 MiB limit")
            chunks.append(chunk)
    finally:
        reader.releaseLock()
    return b"".join(chunks)


async def _fetch_worker_payload(fetch: Any, url: str, options: Any) -> dict[str, Any]:
    """Fetch and consume one bounded response; caller applies a total deadline."""
    response = await fetch(url, options)
    if not response.ok:
        raise RuntimeError(f"NASA POWER request failed with HTTP {response.status}")
    content_length = response.headers.get("content-length")
    if content_length and int(content_length) > NASA_POWER_MAX_RESPONSE_BYTES:
        raise RuntimeError("NASA POWER response exceeded the 2 MiB limit")
    raw = await _read_worker_body(response)
    return _decode_json_response(raw)


async def fetch_daily_point_async(
    latitude: float, longitude: float, start_date: date, end_date: date
) -> dict[str, Any]:
    """Fetch NASA POWER through Workers fetch on Pyodide, or urllib locally."""
    url = _request_url(latitude, longitude, start_date, end_date)

    try:
        from js import Object, fetch
        from pyodide.ffi import to_js
    except ImportError:
        return await asyncio.to_thread(
            fetch_daily_point, latitude, longitude, start_date, end_date
        )

    try:
        options = _worker_fetch_options(to_js, Object.fromEntries)
        payload = await asyncio.wait_for(
            _fetch_worker_payload(fetch, url, options),
            timeout=NASA_POWER_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        raise RuntimeError(f"NASA POWER request failed: {exc}") from exc

    return parse_daily_response(payload)
