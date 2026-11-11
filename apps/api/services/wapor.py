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
MAX_RESPONSE_BYTES = 1 * 1024 * 1024
MAX_PAGES = 8
MAX_ITEMS = 2000
MAPSET_PATTERN = re.compile(r"^L[123]-[A-Z0-9-]{1,32}$")
RASTER_DATE_PATTERN = re.compile(r"\.(\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-D[1-3]|\d{4}-\d{2})$")


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _validate_api_url(url: str) -> None:
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != ALLOWED_HOST
        or parsed.port not in (None, 443)
        or not parsed.path.startswith(ALLOWED_PATH_PREFIX)
        or parsed.username
        or parsed.password
    ):
        raise RuntimeError("WaPOR returned an untrusted pagination URL")


def _request_json(url: str) -> dict[str, Any]:
    _validate_api_url(url)
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "NOVA-Core-Research/0.1"}, method="GET")
    try:
        with build_opener(_RejectRedirects()).open(request, timeout=TIMEOUT_SECONDS) as response:
            if "json" not in response.headers.get("Content-Type", "").lower():
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


async def _request_json_async(url: str) -> dict[str, Any]:
    _validate_api_url(url)
    try:
        from js import Object, fetch
        from pyodide.ffi import to_js
    except ImportError:
        return await asyncio.to_thread(_request_json, url)
    options = to_js(
        {"method": "GET", "headers": {"Accept": "application/json"}, "redirect": "error"},
        dict_converter=Object.fromEntries,
    )
    try:
        response = await asyncio.wait_for(fetch(url, options), timeout=TIMEOUT_SECONDS)
        if not response.ok:
            raise RuntimeError(f"WaPOR request failed with HTTP {response.status}")
        if "json" not in str(response.headers.get("content-type") or "").lower():
            raise RuntimeError("WaPOR returned a non-JSON content type")
        raw = await response.text()
        if len(raw.encode("utf-8")) > MAX_RESPONSE_BYTES:
            raise RuntimeError("WaPOR response exceeded the 1 MiB page limit")
        payload = json.loads(raw)
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


async def list_mapsets_async() -> dict[str, Any]:
    return await asyncio.to_thread(list_mapsets, _request_json)


async def list_rasters_async(
    mapset_code: str, start_date: date | None = None, end_date: date | None = None
) -> dict[str, Any]:
    return await asyncio.to_thread(list_rasters, mapset_code, start_date, end_date, _request_json)
