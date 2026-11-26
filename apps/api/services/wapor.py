"""Bounded, read-only FAO WaPOR v3 mapset and raster-index discovery."""
from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import date
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

BASE_URL = "https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets"
ALLOWED_HOST = "data.apps.fao.org"
ALLOWED_PATH = "/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets"
TIMEOUT_SECONDS = 15
TOTAL_OPERATION_TIMEOUT_SECONDS = 60
MAX_RESPONSE_BYTES = 1 * 1024 * 1024
MAX_PAGES = 8
MAX_ITEMS = 2000
MAPSET_PATTERN = re.compile(r"^L[123]-[A-Z0-9-]{1,32}$")
RASTER_PATH_PATTERN = re.compile(
    re.escape(ALLOWED_PATH) + r"/(L[123]-[A-Z0-9-]{1,32})/rasters"
)
RASTER_DATE_PATTERN = re.compile(
    r"\.(\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-D[1-3]|\d{4}-\d{2})$"
)
GS_URI_PATTERN = re.compile(r"^gs://[a-z0-9._-]{3,222}/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,1024}$")
DOWNLOAD_HOSTS = {"storage.googleapis.com", "storage.cloud.google.com", "data.apps.fao.org"}


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _validate_api_url(url: str) -> None:
    if not isinstance(url, str) or len(url) > 4096:
        raise RuntimeError("WaPOR returned an invalid pagination URL")
    parsed = urlparse(url)
    try:
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("WaPOR returned an untrusted pagination URL") from exc
    valid_path = parsed.path == ALLOWED_PATH or bool(RASTER_PATH_PATTERN.fullmatch(parsed.path))
    if (
        parsed.scheme != "https"
        or parsed.hostname != ALLOWED_HOST
        or port not in (None, 443)
        or not valid_path
        or parsed.username
        or parsed.password
        or parsed.fragment
        or len(parsed.query) > 2048
        or any(ord(char) < 32 for char in url)
    ):
        raise RuntimeError("WaPOR returned an untrusted pagination URL")


def _is_json_content_type(value: str | None) -> bool:
    media_type = (value or "").split(";", 1)[0].strip().lower()
    return media_type == "application/json" or media_type.endswith("+json")


def _validate_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or not isinstance(payload.get("response"), dict):
        raise RuntimeError("WaPOR returned an unexpected response envelope")
    return payload


def _request_json(url: str) -> dict[str, Any]:
    _validate_api_url(url)
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "NOVA-Core-Research/0.1",
        },
        method="GET",
    )
    try:
        with build_opener(_RejectRedirects()).open(
            request, timeout=TIMEOUT_SECONDS
        ) as response:
            if not _is_json_content_type(response.headers.get("Content-Type")):
                raise RuntimeError("WaPOR returned a non-JSON content type")
            deadline = time.monotonic() + TIMEOUT_SECONDS
            chunks: list[bytes] = []
            total = 0
            while True:
                if time.monotonic() >= deadline:
                    raise RuntimeError("WaPOR request exceeded its total time limit")
                chunk = response.read(min(64 * 1024, MAX_RESPONSE_BYTES + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise RuntimeError("WaPOR response exceeded the 1 MiB page limit")
                chunks.append(chunk)
            payload = json.loads(b"".join(chunks).decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"WaPOR request failed with HTTP {exc.code}") from exc
    except (URLError, TimeoutError) as exc:
        raise RuntimeError("WaPOR request failed or timed out") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("WaPOR returned invalid JSON") from exc
    return _validate_payload(payload)


async def _read_worker_response_bytes(response: Any) -> bytes:
    body = getattr(response, "body", None)
    if body is None:
        raise RuntimeError("WaPOR response did not include a readable body")
    reader = body.getReader()
    chunks: list[bytes] = []
    total = 0
    try:
        while True:
            result = await reader.read()
            if result.done:
                break
            chunk = result.value
            chunk_size = int(chunk.byteLength)
            if chunk_size > MAX_RESPONSE_BYTES - total:
                try:
                    await reader.cancel()
                except BaseException:
                    pass
                raise RuntimeError("WaPOR response exceeded the 1 MiB page limit")
            total += chunk_size
            # Check the JavaScript TypedArray byteLength before copying it into Python.
            chunks.append(bytes(chunk.to_py()))
    except BaseException:
        try:
            await reader.cancel()
        except BaseException:
            pass
        raise
    finally:
        try:
            reader.releaseLock()
        except BaseException:
            pass
    return b"".join(chunks)


async def _fetch_worker_payload_with_abort(
    fetch: Any, url: str, options: Any, controller: Any
) -> dict[str, Any]:
    """Abort upstream Fetch before awaiting potentially slow stream cleanup."""
    async def read_response() -> dict[str, Any]:
        response = await fetch(url, options)
        if not response.ok:
            try:
                await response.body.cancel()
            except BaseException:
                pass
            raise RuntimeError(f"WaPOR request failed with HTTP {response.status}")
        if not _is_json_content_type(str(response.headers.get("content-type") or "")):
            try:
                await response.body.cancel()
            except BaseException:
                pass
            raise RuntimeError("WaPOR returned a non-JSON content type")
        raw = await _read_worker_response_bytes(response)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("WaPOR returned invalid JSON") from exc
        return _validate_payload(payload)

    task = asyncio.create_task(read_response())
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=TIMEOUT_SECONDS)
    except asyncio.TimeoutError as exc:
        try:
            controller.abort()
        except BaseException:
            pass
        task.cancel()
        try:
            await task
        except BaseException:
            pass
        raise RuntimeError("WaPOR request exceeded its 15-second deadline") from exc
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


async def _request_json_async(url: str) -> dict[str, Any]:
    _validate_api_url(url)
    try:
        from js import AbortController, Object, fetch
        from pyodide.ffi import to_js
    except ImportError:
        return await asyncio.to_thread(_request_json, url)

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
    return await _fetch_worker_payload_with_abort(fetch, url, options, controller)


def _pagination_next(envelope: dict[str, Any], current_url: str) -> str | None:
    links = envelope.get("links", [])
    if not isinstance(links, list) or not all(isinstance(link, dict) for link in links):
        raise RuntimeError("WaPOR returned an invalid pagination links collection")
    next_links = [link.get("href") for link in links if link.get("rel") == "next"]
    if len(next_links) > 1:
        raise RuntimeError("WaPOR returned ambiguous pagination links")
    if not next_links:
        return None
    href = next_links[0]
    if not isinstance(href, str) or not href.strip():
        raise RuntimeError("WaPOR returned an invalid pagination link")
    next_url = urljoin(current_url, href)
    _validate_api_url(next_url)
    return next_url


def _collect_pages(first_url: str, request_json=_request_json) -> dict[str, Any]:
    next_url: str | None = first_url
    items: list[dict[str, Any]] = []
    visited: set[str] = set()
    pages = 0
    truncated = False
    while next_url and pages < MAX_PAGES and len(items) < MAX_ITEMS:
        _validate_api_url(next_url)
        if next_url in visited:
            raise RuntimeError("WaPOR pagination cycle detected")
        visited.add(next_url)
        envelope = request_json(next_url)["response"]
        page_items = envelope.get("items", [])
        if not isinstance(page_items, list) or not all(
            isinstance(item, dict) for item in page_items
        ):
            raise RuntimeError("WaPOR returned an invalid items collection")
        remaining = MAX_ITEMS - len(items)
        if len(page_items) > remaining:
            truncated = True
        items.extend(page_items[:remaining])
        next_url = _pagination_next(envelope, next_url)
        pages += 1
    if next_url:
        truncated = True
    return {"items": items, "pages_read": pages, "truncated": truncated}


async def _collect_pages_async(first_url: str) -> dict[str, Any]:
    next_url: str | None = first_url
    items: list[dict[str, Any]] = []
    visited: set[str] = set()
    pages = 0
    truncated = False
    while next_url and pages < MAX_PAGES and len(items) < MAX_ITEMS:
        _validate_api_url(next_url)
        if next_url in visited:
            raise RuntimeError("WaPOR pagination cycle detected")
        visited.add(next_url)
        envelope = (await _request_json_async(next_url))["response"]
        page_items = envelope.get("items", [])
        if not isinstance(page_items, list) or not all(
            isinstance(item, dict) for item in page_items
        ):
            raise RuntimeError("WaPOR returned an invalid items collection")
        remaining = MAX_ITEMS - len(items)
        if len(page_items) > remaining:
            truncated = True
        items.extend(page_items[:remaining])
        next_url = _pagination_next(envelope, next_url)
        pages += 1
    if next_url:
        truncated = True
    return {"items": items, "pages_read": pages, "truncated": truncated}


def _safe_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    return cleaned[:limit]


def _mapset_summary(item: dict[str, Any]) -> dict[str, Any] | None:
    code = _safe_text(item.get("code"), 40)
    if not code or not MAPSET_PATTERN.fullmatch(code):
        return None
    return {
        "code": code,
        "caption": _safe_text(item.get("caption"), 200),
        "unit": _safe_text(item.get("unit"), 80),
        "description": _safe_text(item.get("description"), 500),
    }


def _discovery_result(result: dict[str, Any]) -> dict[str, Any]:
    records = [
        summary
        for item in result["items"]
        if (summary := _mapset_summary(item)) is not None
    ]
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


def list_mapsets(request_json=_request_json) -> dict[str, Any]:
    return _discovery_result(_collect_pages(BASE_URL, request_json))


async def list_mapsets_async() -> dict[str, Any]:
    try:
        from js import fetch as _worker_fetch  # noqa: F401
    except ImportError:
        return await asyncio.to_thread(list_mapsets, _request_json)
    result = await asyncio.wait_for(
        _collect_pages_async(BASE_URL),
        timeout=TOTAL_OPERATION_TIMEOUT_SECONDS,
    )
    return _discovery_result(result)


def validate_mapset_code(code: str) -> str:
    if not isinstance(code, str):
        raise ValueError("mapset_code must be a valid WaPOR mapset code")
    normalized = code.strip().upper()
    if not MAPSET_PATTERN.fullmatch(normalized):
        raise ValueError("mapset_code must be a valid WaPOR mapset code")
    return normalized


def _raster_date(code: str) -> date | None:
    match = RASTER_DATE_PATTERN.search(code)
    if not match:
        return None
    value = match.group(1)
    try:
        if "-D" in value:
            year_month, dekad = value.split("-D")
            year, month = map(int, year_month.split("-"))
            day = (int(dekad) - 1) * 10 + 1
            return date(year, month, day)
        if len(value) == 7:
            return date.fromisoformat(value + "-01")
        return date.fromisoformat(value)
    except ValueError:
        return None


def _safe_download_url(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 2048:
        return None
    parsed = urlparse(value)
    try:
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "https"
        or parsed.hostname not in DOWNLOAD_HOSTS
        or port not in (None, 443)
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        return None
    return value


def _safe_gs_uri(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 2048:
        return None
    return value if GS_URI_PATTERN.fullmatch(value) else None


def _raster_records(
    items: list[dict[str, Any]],
    start_date: date | None,
    end_date: date | None,
) -> tuple[list[dict[str, Any]], int]:
    records: list[dict[str, Any]] = []
    unparsed_date_count = 0
    for item in items:
        raster_code = _safe_text(item.get("code"), 180)
        if not raster_code:
            continue
        period = _raster_date(raster_code)
        if (start_date or end_date) and period is None:
            unparsed_date_count += 1
            continue
        if start_date and period and period < start_date:
            continue
        if end_date and period and period > end_date:
            continue
        records.append(
            {
                "code": raster_code,
                "download_url": _safe_download_url(item.get("downloadUrl")),
                "gsutil_uri": _safe_gs_uri(item.get("gsutilUri")),
                "period_start": period.isoformat() if period else None,
            }
        )
    return records, unparsed_date_count


def _raster_result(
    result: dict[str, Any],
    code: str,
    start_date: date | None,
    end_date: date | None,
) -> dict[str, Any]:
    records, unparsed_date_count = _raster_records(result["items"], start_date, end_date)
    return {
        "status": "retrieved",
        "dataset_id": "fao-wapor-v3",
        "mapset_code": code,
        "evidence_class": "satellite_derived",
        "rasters": records,
        "pages_read": result["pages_read"],
        "truncated": result["truncated"],
        "unparsed_date_count": unparsed_date_count,
        "request": {
            "start_date": start_date.isoformat() if start_date else None,
            "end_date": end_date.isoformat() if end_date else None,
        },
        "limitations": [
            "Raster index metadata only; GeoTIFF pixel data is not downloaded or interpreted.",
            "A dekad's period_start is the first calendar day of its ten-day period, not an instantaneous observation timestamp.",
            "Unparseable raster codes are excluded when a date filter is requested.",
            "Provider download URLs and units must be checked before a separate bounded raster-processing stage.",
            "No data is persisted and no site or asset is registered.",
        ],
    }


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
        if available["truncated"]:
            raise RuntimeError("WaPOR mapset catalogue was truncated before the mapset could be verified")
        raise ValueError("mapset_code is not present in the current WaPOR v3 catalogue")
    result = _collect_pages(f"{BASE_URL}/{code}/rasters", request_json)
    return _raster_result(result, code, start_date, end_date)


async def list_rasters_async(
    mapset_code: str,
    start_date: date | None = None,
    end_date: date | None = None,
) -> dict[str, Any]:
    code = validate_mapset_code(mapset_code)
    if start_date and end_date and end_date < start_date:
        raise ValueError("end_date must be on or after start_date")
    try:
        from js import fetch as _worker_fetch  # noqa: F401
    except ImportError:
        return await asyncio.to_thread(
            list_rasters, code, start_date, end_date, _request_json
        )

    async def operation() -> dict[str, Any]:
        available = await _collect_pages_async(BASE_URL)
        if not any(item.get("code") == code for item in available["items"]):
            if available["truncated"]:
                raise RuntimeError("WaPOR mapset catalogue was truncated before the mapset could be verified")
            raise ValueError("mapset_code is not present in the current WaPOR v3 catalogue")
        result = await _collect_pages_async(f"{BASE_URL}/{code}/rasters")
        return _raster_result(result, code, start_date, end_date)

    return await asyncio.wait_for(
        operation(), timeout=TOTAL_OPERATION_TIMEOUT_SECONDS
    )
