"""Read-only FAO WaPOR v3 catalogue and raster-index connector.

This module discovers metadata only. It does not download GeoTIFF pixels,
persist provider data, or create a pilot/site/asset record.
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import date
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.parse import urlparse

BASE_URL = "https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets"
ALLOWED_HOST = "data.apps.fao.org"
ALLOWED_PATH_PREFIX = "/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets"
TIMEOUT_SECONDS = 15
TOTAL_OPERATION_TIMEOUT_SECONDS = 60
MAX_RESPONSE_BYTES = 1 * 1024 * 1024
MAX_PAGES = 8
MAX_ITEMS = 2000
MAPSET_PATTERN = re.compile(r"^L[123]-[A-Z0-9-]{1,32}$")
RASTER_DATE_PATTERN = re.compile(r"\.(\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-D[1-3]|\d{4}-\d{2})$")


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _is_json_content_type(value: Any) -> bool:
    """Accept JSON media types without substring lookalikes."""
    media_type = str(value or "").split(";", 1)[0].strip().lower()
    if "/" not in media_type:
        return False
    media_type_group, subtype = media_type.split("/", 1)
    return media_type_group == "application" and (
        subtype == "json" or subtype.endswith("+json")
    )


def _validate_api_url(url: str) -> None:
    parsed = urlparse(url)
    valid_path = (
        parsed.path == ALLOWED_PATH_PREFIX
        or parsed.path.startswith(ALLOWED_PATH_PREFIX + "/")
    )
    if (
        parsed.scheme != "https"
        or parsed.hostname != ALLOWED_HOST
        or parsed.port not in (None, 443)
        or not valid_path
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise RuntimeError("WaPOR returned an untrusted pagination URL")


def _request_json(url: str) -> dict[str, Any]:
    _validate_api_url(url)
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "NOVA-Core-Research/0.1"}, method="GET")
    try:
        with build_opener(_RejectRedirects()).open(request, timeout=TIMEOUT_SECONDS) as response:
            if not _is_json_content_type(response.headers.get("Content-Type", "")):
                raise RuntimeError("WaPOR returned a non-JSON content type")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise RuntimeError("WaPOR response exceeded the 1 MiB page limit")
            payload = json.loads(raw.decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"WaPOR request failed with HTTP {exc.code}") from exc
    except (URLError, TimeoutError) as exc:
        raise RuntimeError("WaPOR request failed or timed out") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("WaPOR returned invalid JSON") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("response"), dict):
        raise RuntimeError("WaPOR returned an unexpected response envelope")
    return payload


def _worker_fetch_options(
    to_js: Any, object_from_entries: Any, signal: Any = None
) -> Any:
    """Build Fetch options with explicit redirect and abort-signal handling."""
    values = {
        "method": "GET",
        "headers": {"Accept": "application/json"},
        "redirect": "manual",
    }
    if signal is not None:
        values["signal"] = signal
    return to_js(values, dict_converter=object_from_entries)


async def _request_json_async(url: str) -> dict[str, Any]:
    _validate_api_url(url)
    try:
        from js import AbortController, Object, fetch
        from pyodide.ffi import to_js
    except ImportError:
        return await asyncio.to_thread(_request_json, url)
    controller = AbortController()
    options = _worker_fetch_options(to_js, Object.fromEntries, controller.signal)
    try:
        payload = await asyncio.wait_for(
            _fetch_worker_payload_with_abort(fetch, url, options, controller),
            timeout=TIMEOUT_SECONDS,
        )
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError("WaPOR request failed or timed out") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("response"), dict):
        raise RuntimeError("WaPOR returned an unexpected response envelope")
    return payload


def _collect_pages(first_url: str, request_json=_request_json) -> dict[str, Any]:
    next_url: str | None = first_url
    items: list[dict[str, Any]] = []
    pages = 0
    while next_url and pages < MAX_PAGES and len(items) < MAX_ITEMS:
        _validate_api_url(next_url)
        envelope = request_json(next_url)["response"]
        page_items = envelope.get("items", [])
        links = envelope.get("links", [])
        if not isinstance(page_items, list) or not all(isinstance(item, dict) for item in page_items):
            raise RuntimeError("WaPOR returned an invalid items collection")
        items.extend(page_items[: MAX_ITEMS - len(items)])
        next_links = [link.get("href") for link in links if isinstance(link, dict) and link.get("rel") == "next"]
        if len(next_links) > 1:
            raise RuntimeError("WaPOR returned ambiguous pagination links")
        next_url = next_links[0] if next_links else None
        if next_url is not None and not isinstance(next_url, str):
            raise RuntimeError("WaPOR returned an invalid pagination link")
        pages += 1
    return {"items": items, "pages_read": pages, "truncated": bool(next_url) or len(items) >= MAX_ITEMS}


async def _collect_pages_async(
    first_url: str, request_json=None
) -> dict[str, Any]:
    """Collect bounded WaPOR pages without blocking the Worker event loop."""
    if request_json is None:
        request_json = _request_json_async
    next_url: str | None = first_url
    items: list[dict[str, Any]] = []
    pages = 0
    while next_url and pages < MAX_PAGES and len(items) < MAX_ITEMS:
        _validate_api_url(next_url)
        envelope = (await request_json(next_url))["response"]
        page_items = envelope.get("items", [])
        links = envelope.get("links", [])
        if not isinstance(page_items, list) or not all(isinstance(item, dict) for item in page_items):
            raise RuntimeError("WaPOR returned an invalid items collection")
        items.extend(page_items[: MAX_ITEMS - len(items)])
        next_links = [link.get("href") for link in links if isinstance(link, dict) and link.get("rel") == "next"]
        if len(next_links) > 1:
            raise RuntimeError("WaPOR returned ambiguous pagination links")
        next_url = next_links[0] if next_links else None
        if next_url is not None and not isinstance(next_url, str):
            raise RuntimeError("WaPOR returned an invalid pagination link")
        pages += 1
    return {"items": items, "pages_read": pages, "truncated": bool(next_url) or len(items) >= MAX_ITEMS}


async def _read_bounded_response(response: Any) -> bytes:
    """Read a Workers Fetch body incrementally and cancel once it exceeds the cap."""
    body = getattr(response, "body", None)
    if body is None:
        raise RuntimeError("WaPOR response did not expose a readable body")
    reader = body.getReader()
    chunks: list[bytes] = []
    total = 0
    try:
        while True:
            result = await reader.read()
            if result.done:
                break
            chunk_view = result.value
            chunk_size = int(chunk_view.byteLength)
            if total + chunk_size > MAX_RESPONSE_BYTES:
                raise RuntimeError("WaPOR response exceeded the 1 MiB page limit")
            chunk = bytes(chunk_view.to_py())
            if len(chunk) != chunk_size:
                raise RuntimeError("WaPOR response chunk length changed during conversion")
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


async def _fetch_worker_payload(fetch: Any, url: str, options: Any) -> dict[str, Any]:
    response = await fetch(url, options)
    if not response.ok:
        await _cancel_worker_response_body(response)
        raise RuntimeError(f"WaPOR request failed with HTTP {response.status}")
    if not _is_json_content_type(response.headers.get("content-type")):
        await _cancel_worker_response_body(response)
        raise RuntimeError("WaPOR returned a non-JSON content type")
    raw = await _read_bounded_response(response)
    return json.loads(raw.decode("utf-8"))


async def _fetch_worker_payload_with_abort(
    fetch: Any, url: str, options: Any, controller: Any
) -> dict[str, Any]:
    """Abort the underlying Fetch when the Python task fails or is cancelled."""
    try:
        return await _fetch_worker_payload(fetch, url, options)
    except BaseException:
        try:
            controller.abort()
        except BaseException:
            pass
        raise


def _mapset_summary(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": item.get("code"),
        "caption": item.get("caption"),
        "unit": item.get("unit"),
        "description": item.get("description"),
    }


def list_mapsets(request_json=_request_json) -> dict[str, Any]:
    result = _collect_pages(BASE_URL, request_json)
    records = [_mapset_summary(item) for item in result["items"]]
    records = [item for item in records if isinstance(item["code"], str)]
    return {
        "status": "retrieved",
        "dataset_id": "fao-wapor-v3",
        "provider": "Food and Agriculture Organization of the United Nations",
        "evidence_class": "satellite_derived",
        "mapsets": records,
        "pages_read": result["pages_read"],
        "truncated": result["truncated"],
        "limitations": [
            "This endpoint lists provider mapset metadata only; no raster pixels are downloaded.",
            "Mapset availability does not establish coverage or validity for a particular study area.",
            "WaPOR products are satellite-derived/model-processed estimates, not field sensor measurements.",
            "No data is persisted and no site or asset is registered.",
        ],
    }


def validate_mapset_code(code: str) -> str:
    normalized = code.strip().upper()
    if not MAPSET_PATTERN.fullmatch(normalized):
        raise ValueError("mapset_code must be a valid WaPOR mapset code")
    return normalized


def _raster_date(code: str) -> date | None:
    match = RASTER_DATE_PATTERN.search(code)
    if not match:
        return None
    value = match.group(1)
    if "-D" in value:
        year_month, dekad = value.split("-D")
        year, month = map(int, year_month.split("-"))
        day = (int(dekad) - 1) * 10 + 1
        return date(year, month, day)
    if len(value) == 7:
        return date.fromisoformat(value + "-01")
    return date.fromisoformat(value)


def list_rasters(
    mapset_code: str,
    start_date: date | None = None,
    end_date: date | None = None,
    request_json=_request_json,
) -> dict[str, Any]:
    code = validate_mapset_code(mapset_code)
    if start_date and end_date and end_date < start_date:
        raise ValueError("end_date must be on or after start_date")
    available = _collect_pages(BASE_URL, request_json)
    if not any(item.get("code") == code for item in available["items"]):
        raise ValueError("mapset_code is not present in the current WaPOR v3 catalogue")
    result = _collect_pages(f"{BASE_URL}/{code}/rasters", request_json)
    records = []
    for item in result["items"]:
        raster_code = item.get("code")
        if not isinstance(raster_code, str):
            continue
        period = _raster_date(raster_code)
        if start_date and period and period < start_date:
            continue
        if end_date and period and period > end_date:
            continue
        records.append({
            "code": raster_code,
            "download_url": item.get("downloadUrl"),
            "gsutil_uri": item.get("gsutilUri"),
            "period_start": period.isoformat() if period else None,
        })
    return {
        "status": "retrieved",
        "dataset_id": "fao-wapor-v3",
        "mapset_code": code,
        "evidence_class": "satellite_derived",
        "rasters": records,
        "pages_read": result["pages_read"],
        "truncated": result["truncated"],
        "request": {
            "start_date": start_date.isoformat() if start_date else None,
            "end_date": end_date.isoformat() if end_date else None,
        },
        "limitations": [
            "Raster index metadata only; GeoTIFF pixel data is not downloaded or interpreted.",
            "A dekad's period_start is the first calendar day of its ten-day period, not an instantaneous observation timestamp.",
            "Provider download URLs and units must be checked before a separate bounded raster-processing stage.",
            "No data is persisted and no site or asset is registered.",
        ],
    }


async def _within_total_operation_budget(operation: Any) -> Any:
    """Bound the complete endpoint operation, including all pagination pages."""
    try:
        return await asyncio.wait_for(
            operation, timeout=TOTAL_OPERATION_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError as exc:
        raise RuntimeError(
            f"WaPOR operation exceeded the {TOTAL_OPERATION_TIMEOUT_SECONDS}-second total deadline"
        ) from exc


async def list_mapsets_async() -> dict[str, Any]:
    return await _within_total_operation_budget(_list_mapsets_async_impl())


async def list_rasters_async(
    mapset_code: str, start_date: date | None = None, end_date: date | None = None
) -> dict[str, Any]:
    return await _within_total_operation_budget(
        _list_rasters_async_impl(mapset_code, start_date, end_date)
    )


async def _list_mapsets_async_impl() -> dict[str, Any]:
    result = await _collect_pages_async(BASE_URL)
    records = [_mapset_summary(item) for item in result["items"]]
    records = [item for item in records if isinstance(item["code"], str)]
    return {
        "status": "retrieved",
        "dataset_id": "fao-wapor-v3",
        "provider": "Food and Agriculture Organization of the United Nations",
        "evidence_class": "satellite_derived",
        "mapsets": records,
        "pages_read": result["pages_read"],
        "truncated": result["truncated"],
        "limitations": [
            "This endpoint lists provider mapset metadata only; no raster pixels are downloaded.",
            "Mapset availability does not establish coverage or validity for a particular study area.",
            "WaPOR products are satellite-derived/model-processed estimates, not field sensor measurements.",
            "No data is persisted and no site or asset is registered.",
        ],
    }


async def _list_rasters_async_impl(
    mapset_code: str, start_date: date | None = None, end_date: date | None = None
) -> dict[str, Any]:
    code = validate_mapset_code(mapset_code)
    if start_date and end_date and end_date < start_date:
        raise ValueError("end_date must be on or after start_date")
    available = await _collect_pages_async(BASE_URL)
    if not any(item.get("code") == code for item in available["items"]):
        raise ValueError("mapset_code is not present in the current WaPOR v3 catalogue")
    result = await _collect_pages_async(f"{BASE_URL}/{code}/rasters")
    records = []
    for item in result["items"]:
        raster_code = item.get("code")
        if not isinstance(raster_code, str):
            continue
        period = _raster_date(raster_code)
        if start_date and period and period < start_date:
            continue
        if end_date and period and period > end_date:
            continue
        records.append({
            "code": raster_code,
            "download_url": item.get("downloadUrl"),
            "gsutil_uri": item.get("gsutilUri"),
            "period_start": period.isoformat() if period else None,
        })
    return {
        "status": "retrieved",
        "dataset_id": "fao-wapor-v3",
        "mapset_code": code,
        "evidence_class": "satellite_derived",
        "rasters": records,
        "pages_read": result["pages_read"],
        "truncated": result["truncated"],
        "request": {
            "start_date": start_date.isoformat() if start_date else None,
            "end_date": end_date.isoformat() if end_date else None,
        },
        "limitations": [
            "Raster index metadata only; GeoTIFF pixel data is not downloaded or interpreted.",
            "A dekad's period_start is the first calendar day of its ten-day period, not an instantaneous observation timestamp.",
            "Provider download URLs and units must be checked before a separate bounded raster-processing stage.",
            "No data is persisted and no site or asset is registered.",
        ],
    }
