"""Manual, research-only AOI statistics over allowlisted FAO WaPOR v3 COGs.

This module is an opt-in local CLI. It is not wired to a hosted workflow, API,
schedule, database, site registry or telemetry. It never persists raster bytes.
"""
from __future__ import annotations

import calendar
import hashlib
import json
import math
import os
import re
import sys
from datetime import date, datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
from typing import Any

from apps.api.services.raster_provenance import RasterProcessingManifest
from apps.api.services.research_aoi import validate_research_aoi
from apps.api.services.wapor import list_mapsets, list_rasters, validate_mapset_code

MAX_COG_OBJECT_BYTES = 256 * 1024 * 1024
MAX_AOI_WINDOW_PIXELS = 10_000_000
MAX_AOI_GEOJSON_BYTES = 1 * 1024 * 1024
COG_HOST = "storage.googleapis.com"
COG_BUCKET = "fao-gismgr-wapor-3-data"
COG_BUCKET_PREFIX = f"/{COG_BUCKET}/DATA/WAPOR-3/MAPSET/"
RASTER_CODE_PATTERN = re.compile(r"^WAPOR-3\.(L[123]-[A-Z0-9-]{1,32})\.(\d{4}-\d{2}-D[1-3])$")
SUPPORTED_DTYPES = {"uint8", "uint16", "uint32", "int8", "int16", "int32", "float32", "float64"}


class ResearchProcessingError(RuntimeError):
    """Raised when a public provider asset cannot be processed safely."""


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_wapor_download_url(url: str, mapset_code: str, raster_code: str) -> str:
    """Accept only the exact FAO v3 GCS object path for the requested dekadal raster."""
    if not isinstance(url, str) or len(url) > 2048 or any(ord(char) < 32 for char in url):
        raise ResearchProcessingError("WaPOR downloadUrl is not a bounded URL string")
    try:
        mapset = validate_mapset_code(mapset_code)
        match = RASTER_CODE_PATTERN.fullmatch(raster_code)
        parsed = urlparse(url)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ResearchProcessingError("WaPOR mapset, raster code or downloadUrl is malformed") from exc
    if not match or match.group(1) != mapset:
        raise ResearchProcessingError("raster_code does not belong to the requested dekadal mapset")
    expected_path = f"{COG_BUCKET_PREFIX}{mapset}/{raster_code}.tif"
    if (
        parsed.scheme != "https"
        or parsed.hostname != COG_HOST
        or parsed.netloc.lower() not in (COG_HOST, f"{COG_HOST}:443")
        or port not in (None, 443)
        or parsed.username
        or parsed.password
        or parsed.path != expected_path
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise ResearchProcessingError("WaPOR downloadUrl is outside the exact allowlisted COG object path")
    return url


def dekadal_period(raster_code: str) -> tuple[date, date]:
    """Return the inclusive calendar period represented by a WaPOR dekad code."""
    if not isinstance(raster_code, str):
        raise ResearchProcessingError("raster_code must be a string")
    match = RASTER_CODE_PATTERN.fullmatch(raster_code)
    if not match:
        raise ResearchProcessingError("Only explicitly identified WaPOR dekadal raster codes are supported")
    year_text, month_text, dekad_text = match.group(2).split("-")
    year, month, dekad = int(year_text), int(month_text), int(dekad_text[1])
    try:
        last_day = calendar.monthrange(year, month)[1]
        start_day = (dekad - 1) * 10 + 1
        end_day = min(dekad * 10, last_day)
        return date(year, month, start_day), date(year, month, end_day)
    except ValueError as exc:
        raise ResearchProcessingError("WaPOR raster code contains an invalid calendar period") from exc


def _validate_provider_period(raster_code: str, provider_period_start: Any) -> tuple[date, date]:
    start, end = dekadal_period(raster_code)
    if not isinstance(provider_period_start, str) or provider_period_start != start.isoformat():
        raise ResearchProcessingError("WaPOR catalogue period_start does not match the dekadal raster code")
    return start, end


def _validate_initial_range(content_range: str, prefix: bytes, expected_size: int) -> None:
    """Require an exact four-byte range whose advertised object size matches HEAD."""
    match = re.fullmatch(r"bytes 0-3/(\d+)", content_range.strip() if isinstance(content_range, str) else "")
    if match is None or int(match.group(1)) != expected_size:
        raise ResearchProcessingError("WaPOR COG returned an invalid or inconsistent initial byte range")
    if len(prefix) != 4:
        raise ResearchProcessingError("WaPOR COG returned an incomplete initial byte range")
    if prefix not in (b"II*\x00", b"MM\x00*"):
        raise ResearchProcessingError("WaPOR COG does not begin with a classic TIFF signature")


def _preflight_cog(url: str) -> int:
    """Reject redirects, non-TIFF objects and unbounded remote object sizes."""
    opener = build_opener(_RejectRedirects())
    headers = {
        "User-Agent": "NOVA-Core-Research/0.1",
        "Accept": "image/tiff,application/octet-stream",
    }
    try:
        request = Request(url, headers=headers, method="HEAD")
        with opener.open(request, timeout=20) as response:
            if response.status != 200:
                raise ResearchProcessingError("WaPOR COG HEAD preflight did not return HTTP 200")
            content_length = response.headers.get("Content-Length")
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if not content_length or not content_length.isdigit():
            raise ResearchProcessingError("WaPOR COG did not provide a bounded Content-Length")
        size = int(content_length)
        if size < 8 or size > MAX_COG_OBJECT_BYTES:
            raise ResearchProcessingError("WaPOR COG object size is outside the 256 MiB research limit")
        if content_type not in ("image/tiff", "application/octet-stream", "binary/octet-stream"):
            raise ResearchProcessingError("WaPOR COG returned an unexpected content type")

        range_request = Request(
            url,
            headers={**headers, "Range": "bytes=0-3"},
            method="GET",
        )
        with opener.open(range_request, timeout=20) as response:
            if response.status != 206:
                raise ResearchProcessingError("WaPOR COG server did not honor the bounded byte-range request")
            range_length = response.headers.get("Content-Length")
            if range_length != "4":
                raise ResearchProcessingError("WaPOR COG returned an unexpected initial range length")
            prefix = response.read(5)
            content_range = response.headers.get("Content-Range", "")
        _validate_initial_range(content_range, prefix, size)
        return size
    except ResearchProcessingError:
        raise
    except HTTPError as exc:
        raise ResearchProcessingError(f"WaPOR COG preflight failed with HTTP {exc.code}") from exc
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        raise ResearchProcessingError("WaPOR COG preflight failed or timed out") from exc


def _canonical_bytes(payload: Any) -> bytes:
    try:
        return json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ResearchProcessingError("Research metadata must be finite, JSON-serializable data") from exc


def _canonical_hash(payload: Any) -> str:
    return hashlib.sha256(_canonical_bytes(payload)).hexdigest()


def _canonical_aoi_hash(geometry: dict[str, Any]) -> str:
    encoded = _canonical_bytes(geometry)
    if len(encoded) > MAX_AOI_GEOJSON_BYTES:
        raise ResearchProcessingError("AOI GeoJSON exceeds the 1 MiB input limit")
    return hashlib.sha256(encoded).hexdigest()


def _window_digest(
    array,
    inside_mask,
    valid_mask,
    *,
    crs: str,
    transform: tuple[float, ...],
    window: tuple[int, ...],
) -> str:
    """Hash exact AOI-window samples, masks, dtype and spatial interpretation."""
    import numpy as np

    samples = np.ascontiguousarray(array)
    if samples.dtype.byteorder == ">" or (samples.dtype.byteorder == "=" and sys.byteorder == "big"):
        samples = samples.byteswap().view(samples.dtype.newbyteorder("<"))
    digest = hashlib.sha256()
    digest.update(b"NOVA-WAPOR-AOI-WINDOW-V1\x00")
    digest.update(samples.dtype.str.encode("ascii"))
    digest.update(samples.tobytes(order="C"))
    digest.update(np.ascontiguousarray(inside_mask, dtype=np.uint8).tobytes(order="C"))
    digest.update(np.ascontiguousarray(valid_mask, dtype=np.uint8).tobytes(order="C"))
    digest.update(_canonical_hash({
        "crs": crs,
        "transform": list(transform),
        "window": list(window),
        "shape": list(samples.shape),
    }).encode("ascii"))
    return digest.hexdigest()


def _masked_statistics(samples, inside_mask, provider_mask, nodata) -> dict[str, Any]:
    """Calculate raw statistics with a bounded dtype allow-list and explicit masks."""
    import numpy as np

    array = np.asarray(samples)
    inside = np.asarray(inside_mask, dtype=bool)
    provider_valid = np.asarray(provider_mask, dtype=bool)
    if array.ndim != 2 or inside.shape != array.shape or provider_valid.shape != array.shape:
        raise ResearchProcessingError("AOI samples and masks must have matching two-dimensional shapes")
    if array.dtype.name not in SUPPORTED_DTYPES:
        raise ResearchProcessingError("WaPOR raster sample dtype is outside the supported 8/16/32-bit integer or 32/64-bit float set")
    if array.size < 1 or array.size > MAX_AOI_WINDOW_PIXELS:
        raise ResearchProcessingError("AOI crop must contain between 1 and 10 million pixels")

    valid = inside & provider_valid & np.isfinite(array)
    if nodata is not None:
        try:
            nodata_value = float(nodata)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ResearchProcessingError("WaPOR NoData sentinel is not numeric") from exc
        if math.isnan(nodata_value):
            valid &= ~np.isnan(array)
        elif math.isfinite(nodata_value):
            valid &= array != nodata_value
        else:
            raise ResearchProcessingError("Infinite WaPOR NoData sentinels are not supported")

    outside_count = int(np.count_nonzero(~inside))
    nodata_count = int(np.count_nonzero(inside & ~valid))
    values = array[valid]
    if values.size == 0:
        return {
            "valid_pixel_count": 0,
            "nodata_pixel_count": nodata_count,
            "outside_aoi_pixel_count": outside_count,
            "raw_min": None,
            "raw_max": None,
            "raw_mean": None,
            "_valid_mask": valid,
        }

    numeric = values.astype(np.float64, copy=False)
    raw_min = float(np.min(numeric))
    raw_max = float(np.max(numeric))
    scale = max(abs(raw_min), abs(raw_max))
    raw_mean = 0.0 if scale == 0 else float(np.mean(numeric / scale, dtype=np.float64) * scale)
    if not all(math.isfinite(value) for value in (raw_min, raw_max, raw_mean)):
        raise ResearchProcessingError("AOI raster statistics exceed the supported numeric range")
    return {
        "valid_pixel_count": int(values.size),
        "nodata_pixel_count": nodata_count,
        "outside_aoi_pixel_count": outside_count,
        "raw_min": raw_min,
        "raw_max": raw_max,
        "raw_mean": raw_mean,
        "_valid_mask": valid,
    }


def _crs_identifier(crs) -> str:
    authority = crs.to_authority()
    if authority and authority[0].upper() == "EPSG":
        identifier = f"EPSG:{authority[1]}"
    elif crs.to_string().upper() == "OGC:CRS84":
        identifier = "OGC:CRS84"
    else:
        raise ResearchProcessingError("WaPOR COG CRS must resolve to an explicit EPSG identifier or OGC:CRS84")
    if identifier == "EPSG:32767":
        raise ResearchProcessingError("User-defined GeoTIFF CRS code 32767 is not an EPSG identifier")
    return identifier


def _require_discovered_record(
    discovery: dict[str, Any],
    records_key: str,
    record_code: str,
    *,
    resource_label: str,
) -> dict[str, Any]:
    """Only report absence when provider enumeration is known to be complete."""
    records = discovery.get(records_key)
    if not isinstance(records, list):
        raise ResearchProcessingError(f"WaPOR {resource_label} discovery returned an invalid record collection")
    record = next(
        (item for item in records if isinstance(item, dict) and item.get("code") == record_code),
        None,
    )
    if record is not None:
        return record
    if discovery.get("truncated") is True:
        raise ResearchProcessingError(
            f"WaPOR {resource_label} discovery was truncated; absence of {record_code} cannot be established"
        )
    raise ResearchProcessingError(
        f"Requested {resource_label} {record_code} is not present in the complete FAO WaPOR v3 discovery result"
    )


def process_wapor_aoi(
    mapset_code: str,
    raster_code: str,
    aoi_geometry: dict[str, Any],
    *,
    processing_code_commit: str,
) -> dict[str, Any]:
    """Fetch a bounded WaPOR catalogue record and calculate AOI-only raw pixel stats."""
    try:
        mapset = validate_mapset_code(mapset_code)
    except ValueError as exc:
        raise ResearchProcessingError("mapset_code is invalid") from exc
    if not isinstance(processing_code_commit, str) or not re.fullmatch(r"[a-f0-9]{40}", processing_code_commit):
        raise ResearchProcessingError("processing_code_commit must be a 40-character lowercase Git SHA")
    aoi_hash = _canonical_aoi_hash(aoi_geometry)
    aoi_summary = validate_research_aoi(aoi_geometry)

    try:
        catalogue = list_mapsets()
        mapset_record = _require_discovered_record(
            catalogue,
            "mapsets",
            mapset,
            resource_label="mapset catalogue",
        )
        raster_index = list_rasters(mapset)
        raster_record = _require_discovered_record(
            raster_index,
            "rasters",
            raster_code,
            resource_label="raster index",
        )
    except ResearchProcessingError:
        raise
    except Exception as exc:
        raise ResearchProcessingError("FAO WaPOR catalogue discovery failed") from exc

    download_url = validate_wapor_download_url(raster_record.get("download_url"), mapset, raster_code)
    period_start, period_end = _validate_provider_period(raster_code, raster_record.get("period_start"))
    source_object_size = _preflight_cog(download_url)

    try:
        import numpy as np
        import rasterio
        from rasterio.errors import WindowError
        from rasterio.features import geometry_mask, geometry_window
        from rasterio.warp import transform_geom
        from shapely.geometry import shape
    except ImportError as exc:
        raise ResearchProcessingError("Research raster dependencies are missing; install requirements-research.txt") from exc

    polygon = shape(aoi_geometry)
    if polygon.is_empty or not polygon.is_valid or polygon.geom_type not in ("Polygon", "MultiPolygon"):
        raise ResearchProcessingError("AOI must be a topologically valid Polygon or MultiPolygon")

    try:
        with rasterio.Env(
            GDAL_HTTP_FOLLOW_REDIRECTS="NO",
            GDAL_HTTP_MAX_RETRY="0",
            GDAL_HTTP_TIMEOUT="20",
            GDAL_HTTP_CONNECTTIMEOUT="10",
            GDAL_HTTP_MULTIRANGE="YES",
            CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
            CPL_VSIL_CURL_USE_HEAD="YES",
            CPL_VSIL_CURL_CHUNK_SIZE=16384,
            GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
            GDAL_CACHEMAX=64,
        ):
            with rasterio.open(download_url) as source:
                if source.driver != "GTiff":
                    raise ResearchProcessingError("Allowlisted WaPOR object is not a GeoTIFF")
                if source.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG":
                    raise ResearchProcessingError("WaPOR GeoTIFF is not identified by GDAL as a Cloud Optimized GeoTIFF")
                if source.count != 1:
                    raise ResearchProcessingError("Only single-band WaPOR COG rasters are supported")
                if source.crs is None:
                    raise ResearchProcessingError("WaPOR COG is missing an explicit coordinate reference system")
                if source.width > 100_000 or source.height > 100_000:
                    raise ResearchProcessingError("WaPOR source dimensions exceed the provenance model bounds")
                source_dtype = source.dtypes[0]
                if source_dtype not in SUPPORTED_DTYPES:
                    raise ResearchProcessingError("WaPOR COG sample dtype is not supported by this research runner")
                crs_identifier = _crs_identifier(source.crs)
                transformed_geometry = transform_geom(
                    "OGC:CRS84",
                    source.crs,
                    aoi_geometry,
                    precision=-1,
                )
                try:
                    window = geometry_window(source, [transformed_geometry], boundless=True)
                except WindowError as exc:
                    raise ResearchProcessingError("Research AOI does not intersect the selected WaPOR raster") from exc
                window = window.round_offsets(op=math.floor).round_lengths(op=math.ceil)
                window_width, window_height = int(window.width), int(window.height)
                if (
                    window_width < 1
                    or window_height < 1
                    or window_width * window_height > MAX_AOI_WINDOW_PIXELS
                    or window.col_off < 0
                    or window.row_off < 0
                    or window.col_off + window_width > source.width
                    or window.row_off + window_height > source.height
                ):
                    raise ResearchProcessingError("AOI crop is outside raster bounds or exceeds the 10 million pixel limit")

                samples = source.read(1, window=window, masked=False)
                if samples.shape != (window_height, window_width):
                    raise ResearchProcessingError("GDAL returned a pixel window with unexpected dimensions")
                crop_transform = source.window_transform(window)
                inside = geometry_mask(
                    [transformed_geometry],
                    out_shape=samples.shape,
                    transform=crop_transform,
                    invert=True,
                    all_touched=False,
                )
                provider_mask = source.read_masks(1, window=window) > 0
                if provider_mask.shape != samples.shape:
                    raise ResearchProcessingError("GDAL returned a validity mask with unexpected dimensions")
                nodata = source.nodata
                statistics = _masked_statistics(samples, inside, provider_mask, nodata)
                valid_mask = statistics.pop("_valid_mask")

                transform_tuple = (
                    float(crop_transform.c), float(crop_transform.a), float(crop_transform.b),
                    float(crop_transform.f), float(crop_transform.d), float(crop_transform.e),
                )
                window_tuple = (
                    int(window.col_off), int(window.row_off), window_width, window_height,
                )
                processed_hash = _window_digest(
                    samples,
                    inside,
                    valid_mask,
                    crs=crs_identifier,
                    transform=transform_tuple,
                    window=window_tuple,
                )
                source_width, source_height = int(source.width), int(source.height)
                source_nodata = None if nodata is None else str(nodata)
    except ResearchProcessingError:
        raise
    except Exception as exc:
        raise ResearchProcessingError("WaPOR COG could not be safely read or AOI statistics could not be calculated") from exc

    metadata_hash = _canonical_hash({
        "mapset": mapset_record,
        "raster": {
            "code": raster_record.get("code"),
            "period_start": raster_record.get("period_start"),
            "download_url": download_url,
            "gsutil_uri": raster_record.get("gsutil_uri"),
        },
    })
    unit = mapset_record.get("unit")
    manifest = RasterProcessingManifest(
        manifest_id=f"wapor.{mapset.lower()}.{period_start.isoformat()}.d{(period_start.day - 1) // 10 + 1}",
        provider="FAO WaPOR",
        dataset_id="fao-wapor-v3",
        dataset_version="v3",
        mapset_code=mapset,
        raster_code=raster_code,
        provider_period_start=period_start,
        provider_period_end=period_end,
        retrieved_at=datetime.now(timezone.utc),
        processed_window_sha256=processed_hash,
        provider_metadata_sha256=metadata_hash,
        processing_code_commit=processing_code_commit,
        processing_method="nova-wapor-cog-aoi-v1",
        source_dtype=source_dtype,
        source_nodata=source_nodata,
        width=window_width,
        height=window_height,
        source_width=source_width,
        source_height=source_height,
        valid_pixel_count=statistics["valid_pixel_count"],
        nodata_pixel_count=statistics["nodata_pixel_count"],
        outside_aoi_pixel_count=statistics["outside_aoi_pixel_count"],
        raw_min=statistics["raw_min"],
        raw_max=statistics["raw_max"],
        raw_mean=statistics["raw_mean"],
        units=unit if isinstance(unit, str) and unit.strip() else None,
        crs_identifier=crs_identifier,
        geotransform=transform_tuple,
        aoi_sha256=aoi_hash,
        aoi_bbox=tuple(aoi_summary["bbox"]),
    )
    return {
        "status": "research_result",
        "manifest": manifest.model_dump(mode="json"),
        "source": {
            "object_size_bytes": source_object_size,
            "object_sha256": None,
            "dtype": source_dtype,
            "nodata_value": source_nodata,
            "download_mode": "allowlisted COG byte-range reads; no unconditional full-object GET was requested",
        },
        "window": {
            "column_offset": window_tuple[0],
            "row_offset": window_tuple[1],
            "width": window_width,
            "height": window_height,
        },
        "limitations": [
            "WaPOR is satellite-derived/model-processed data, not a field sensor observation.",
            "Only the caller-supplied research AOI window was read; no customer site or pilot was registered.",
            "No full source-object SHA-256 was calculated; processed_window_sha256 covers samples, masks and spatial window metadata.",
            "No calibration was applied because authoritative per-raster scale/offset metadata was not independently verified.",
            "No unit was inferred; units are emitted only when present in FAO mapset metadata.",
            "This result is research evidence only and is not a validated forecast, recommendation or operational control signal.",
        ],
    }


def main() -> int:
    try:
        mapset = os.environ["NOVA_WAPOR_MAPSET_CODE"]
        raster = os.environ["NOVA_WAPOR_RASTER_CODE"]
        aoi_json = os.environ["NOVA_WAPOR_AOI_GEOJSON"]
        if len(aoi_json.encode("utf-8")) > MAX_AOI_GEOJSON_BYTES:
            raise ResearchProcessingError("AOI GeoJSON exceeds the 1 MiB input limit")
        aoi = json.loads(aoi_json)
        commit = os.environ.get("GITHUB_SHA") or os.environ.get("NOVA_PROCESSING_CODE_COMMIT", "")
        result = process_wapor_aoi(mapset, raster, aoi, processing_code_commit=commit)
        print(json.dumps(result, indent=2, sort_keys=True, allow_nan=False))
        return 0
    except (KeyError, json.JSONDecodeError, ResearchProcessingError, ValueError) as exc:
        print(json.dumps({"status": "rejected", "error": str(exc)}, indent=2))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
