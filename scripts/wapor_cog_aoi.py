"""Manual, research-only AOI statistics over allowlisted FAO WaPOR v3 COGs.

The runner reads only the COG byte ranges required for a caller-supplied AOI.
It does not persist raster data, create a site/source record, or publish telemetry.
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

MAX_COG_OBJECT_BYTES = 1 * 1024 * 1024 * 1024
MAX_AOI_WINDOW_PIXELS = 10_000_000
COG_HOST = "storage.googleapis.com"
COG_BUCKET_PREFIX = "/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET/"
RASTER_CODE_PATTERN = re.compile(r"^WAPOR-3\.(L[123]-[A-Z0-9-]{1,32})\.(\d{4}-\d{2}-D[1-3])$")


class ResearchProcessingError(RuntimeError):
    """Raised when a public provider asset cannot be processed safely."""


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_wapor_download_url(url: str, mapset_code: str, raster_code: str) -> str:
    """Accept only the exact FAO v3 COG object path for the requested raster."""
    mapset = validate_mapset_code(mapset_code)
    match = RASTER_CODE_PATTERN.fullmatch(raster_code)
    if not match or match.group(1) != mapset:
        raise ResearchProcessingError("raster_code does not belong to the requested dekadal mapset")
    parsed = urlparse(url)
    expected_path = f"{COG_BUCKET_PREFIX}{mapset}/{raster_code}.tif"
    if (
        parsed.scheme != "https"
        or parsed.hostname != COG_HOST
        or parsed.port not in (None, 443)
        or parsed.username
        or parsed.password
        or parsed.path != expected_path
        or parsed.query
        or parsed.fragment
    ):
        raise ResearchProcessingError("WaPOR downloadUrl is outside the exact allowlisted COG object path")
    return url


def dekadal_period(raster_code: str) -> tuple[date, date]:
    """Return the inclusive calendar period represented by a WaPOR dekad code."""
    match = RASTER_CODE_PATTERN.fullmatch(raster_code)
    if not match:
        raise ResearchProcessingError("Only explicitly identified WaPOR dekadal raster codes are supported")
    year_text, month_text, dekad_text = match.group(2).split("-")
    year, month, dekad = int(year_text), int(month_text), int(dekad_text[1])
    last_day = calendar.monthrange(year, month)[1]
    start_day = (dekad - 1) * 10 + 1
    end_day = min(dekad * 10, last_day)
    return date(year, month, start_day), date(year, month, end_day)


def _preflight_cog(url: str) -> int:
    """Reject redirects, non-TIFF objects and unbounded remote object sizes."""
    opener = build_opener(_RejectRedirects())
    headers = {"User-Agent": "NOVA-Core-Research/0.1", "Accept": "image/tiff,application/octet-stream"}
    try:
        request = Request(url, headers=headers, method="HEAD")
        with opener.open(request, timeout=20) as response:
            if response.status != 200:
                raise ResearchProcessingError("WaPOR COG HEAD preflight did not return HTTP 200")
            content_length = response.headers.get("Content-Length")
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if not content_length or not content_length.isdigit():
            raise ResearchProcessingError("WaPOR COG did not provide a bounded Content-Length")
        size = int(content_length)
        if size < 8 or size > MAX_COG_OBJECT_BYTES:
            raise ResearchProcessingError("WaPOR COG object size is outside the 1 GiB research limit")
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
            prefix = response.read(4)
            content_range = response.headers.get("Content-Range", "")
            if not content_range.startswith("bytes 0-3/"):
                raise ResearchProcessingError("WaPOR COG returned an invalid initial byte range")
        if prefix not in (b"II*\x00", b"MM\x00*"):
            raise ResearchProcessingError("WaPOR COG does not begin with a classic TIFF signature")
        return size
    except HTTPError as exc:
        raise ResearchProcessingError(f"WaPOR COG preflight failed with HTTP {exc.code}") from exc
    except (URLError, TimeoutError) as exc:
        raise ResearchProcessingError("WaPOR COG preflight failed or timed out") from exc


def _canonical_hash(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _window_digest(array, inside_mask, valid_mask, *, crs: str, transform: tuple[float, ...], window: tuple[int, ...]) -> str:
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


def process_wapor_aoi(
    mapset_code: str,
    raster_code: str,
    aoi_geometry: dict[str, Any],
    *,
    processing_code_commit: str,
) -> dict[str, Any]:
    """Fetch a WaPOR catalogue record and calculate bounded AOI-only pixel stats."""
    mapset = validate_mapset_code(mapset_code)
    if not re.fullmatch(r"[a-f0-9]{40}", processing_code_commit):
        raise ResearchProcessingError("processing_code_commit must be a 40-character lowercase Git SHA")

    aoi_summary = validate_research_aoi(aoi_geometry)
    catalogue = list_mapsets()
    mapset_record = next((item for item in catalogue["mapsets"] if item.get("code") == mapset), None)
    if mapset_record is None:
        raise ResearchProcessingError("Requested mapset is not present in the current FAO WaPOR v3 catalogue")

    raster_index = list_rasters(mapset)
    raster_record = next((item for item in raster_index["rasters"] if item.get("code") == raster_code), None)
    if raster_record is None:
        raise ResearchProcessingError("Requested raster code is not present in the selected WaPOR mapset index")
    download_url = validate_wapor_download_url(raster_record.get("download_url", ""), mapset, raster_code)
    source_object_size = _preflight_cog(download_url)
    period_start, period_end = dekadal_period(raster_code)

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
            GDAL_HTTP_MAX_RETRY="1",
            GDAL_HTTP_TIMEOUT="20",
            CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
            CPL_VSIL_CURL_USE_HEAD="YES",
            GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
            GDAL_CACHEMAX="64",
        ):
            with rasterio.open(download_url) as source:
                if source.count != 1:
                    raise ResearchProcessingError("Only single-band WaPOR COG rasters are supported")
                if source.crs is None:
                    raise ResearchProcessingError("WaPOR COG is missing an explicit coordinate reference system")
                transformed_geometry = transform_geom("OGC:CRS84", source.crs, aoi_geometry, precision=-1)
                try:
                    window = geometry_window(source, [transformed_geometry])
                except WindowError as exc:
                    raise ResearchProcessingError("Research AOI does not intersect the selected WaPOR raster") from exc
                window = window.round_offsets().round_lengths()
                window_width, window_height = int(window.width), int(window.height)
                if window_width < 1 or window_height < 1 or window_width * window_height > MAX_AOI_WINDOW_PIXELS:
                    raise ResearchProcessingError("AOI crop exceeds the 10 million pixel research processing limit")

                samples = source.read(1, window=window, masked=False)
                crop_transform = source.window_transform(window)
                inside = geometry_mask(
                    [transformed_geometry],
                    out_shape=samples.shape,
                    transform=crop_transform,
                    invert=True,
                    all_touched=False,
                )
                provider_mask = source.read_masks(1, window=window) > 0
                valid = inside & provider_mask & np.isfinite(samples)
                nodata = source.nodata
                if nodata is not None:
                    if isinstance(nodata, float) and math.isnan(nodata):
                        valid &= ~np.isnan(samples)
                    else:
                        valid &= samples != nodata
                outside_count = int(np.count_nonzero(~inside))
                nodata_count = int(np.count_nonzero(inside & ~valid))
                values = samples[valid].astype(np.float64, copy=False)
                if values.size:
                    raw_min = float(np.min(values))
                    raw_max = float(np.max(values))
                    raw_mean = float(np.mean(values, dtype=np.float64))
                    if not all(math.isfinite(value) for value in (raw_min, raw_max, raw_mean)):
                        raise ResearchProcessingError("AOI raster statistics exceed the supported numeric range")
                else:
                    raw_min = raw_max = raw_mean = None

                crs_identifier = source.crs.to_string()
                transform_tuple = (
                    float(crop_transform.c), float(crop_transform.a), float(crop_transform.b),
                    float(crop_transform.f), float(crop_transform.d), float(crop_transform.e),
                )
                window_tuple = (
                    int(window.col_off), int(window.row_off), window_width, window_height,
                )
                processed_hash = _window_digest(
                    samples, inside, valid,
                    crs=crs_identifier,
                    transform=transform_tuple,
                    window=window_tuple,
                )
                source_width, source_height = int(source.width), int(source.height)
                source_dtype = source.dtypes[0]
                source_nodata = None if nodata is None else str(nodata)
    except ResearchProcessingError:
        raise
    except Exception as exc:
        raise ResearchProcessingError("WaPOR COG could not be safely read or AOI statistics could not be calculated") from exc

    aoi_hash = _canonical_hash(aoi_geometry)
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
        width=window_width,
        height=window_height,
        source_width=source_width,
        source_height=source_height,
        valid_pixel_count=int(values.size),
        nodata_pixel_count=nodata_count,
        outside_aoi_pixel_count=outside_count,
        raw_min=raw_min,
        raw_max=raw_max,
        raw_mean=raw_mean,
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
            "download_mode": "allowlisted COG byte-range reads; full source object was not downloaded",
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
        aoi = json.loads(os.environ["NOVA_WAPOR_AOI_GEOJSON"])
        commit = os.environ["GITHUB_SHA"]
        result = process_wapor_aoi(mapset, raster, aoi, processing_code_commit=commit)
        print(json.dumps(result, indent=2, sort_keys=True, allow_nan=False))
        return 0
    except (KeyError, json.JSONDecodeError, ResearchProcessingError, ValueError) as exc:
        print(json.dumps({"status": "rejected", "error": str(exc)}, indent=2))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
