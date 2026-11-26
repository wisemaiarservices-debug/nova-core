"""Bounded statistics for a deliberately narrow subset of classic GeoTIFF.

Supports single-image, single-band, uncompressed, chunky TIFF strips with
predictor 1. No network, decompression, reprojection, resampling, persistence
or unit inference.
"""
from __future__ import annotations

import math
import struct
from typing import Any

from apps.api.services.geotiff_metadata import (
    MAX_TIFF_BYTES,
    GeoTiffError,
    inspect_geotiff,
)

MAX_STATISTICS_PIXELS = 10_000_000
MAX_STRIPS = 4096
_FORMATS = {
    (1, 8): "B", (1, 16): "H", (1, 32): "I",
    (2, 8): "b", (2, 16): "h", (2, 32): "i",
    (3, 32): "f", (3, 64): "d",
}
_FIELD_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}
_RELEVANT_TYPES = {
    258: {3}, 259: {3}, 273: {3, 4}, 277: {3}, 278: {3, 4},
    279: {3, 4}, 284: {3}, 317: {3}, 339: {3},
}
_ARRAY_TAGS = {273, 279}


def _overlaps(left: tuple[int, int], right: tuple[int, int]) -> bool:
    return left[0] < right[1] and right[0] < left[1]


def _entries(
    data: bytes,
) -> tuple[str, dict[int, tuple[int, list[int] | list[float]]], list[tuple[int, int]]]:
    """Read strip/sample tags and protect every external IFD value range."""
    endian = "<" if data[:2] == b"II" else ">"
    ifd_offset = struct.unpack(endian + "I", data[4:8])[0]
    count = struct.unpack(endian + "H", data[ifd_offset:ifd_offset + 2])[0]
    ifd_end = ifd_offset + 2 + count * 12 + 4
    if struct.unpack(endian + "I", data[ifd_end - 4:ifd_end])[0] != 0:
        raise GeoTiffError("Multi-image TIFF files are not supported")
    protected = [(0, 8), (ifd_offset, ifd_end)]
    tags: dict[int, tuple[int, list[int] | list[float]]] = {}
    seen: set[int] = set()
    for index in range(count):
        pos = ifd_offset + 2 + index * 12
        tag, kind, value_count = struct.unpack(endian + "HHI", data[pos:pos + 8])
        if tag in seen:
            raise GeoTiffError("TIFF contains a duplicate tag in the strip/sample layout")
        seen.add(tag)
        type_size = _FIELD_SIZES.get(kind)
        if type_size is None:
            raise GeoTiffError("TIFF contains an unsupported field type")
        total = value_count * type_size
        if total > len(data):
            raise GeoTiffError("TIFF metadata field exceeds the bounded input size")
        value_field = data[pos + 8:pos + 12]
        value_offset = pos + 8 if total <= 4 else struct.unpack(endian + "I", value_field)[0]
        if value_offset + total > len(data):
            raise GeoTiffError("TIFF strip metadata points outside the bounded file")
        if total > 4:
            value_range = (value_offset, value_offset + total)
            if _overlaps(value_range, protected[0]) or _overlaps(value_range, protected[1]):
                raise GeoTiffError("TIFF external metadata overlaps its header or IFD")
            protected.append(value_range)
        if tag not in _RELEVANT_TYPES:
            continue
        if kind not in _RELEVANT_TYPES[tag]:
            raise GeoTiffError(f"TIFF strip/sample tag {tag} has an unexpected field type")
        if tag in _ARRAY_TAGS:
            if value_count < 1 or value_count > MAX_STRIPS:
                raise GeoTiffError("TIFF strip offset/count array exceeds the 4,096-strip limit")
        elif value_count < 1 or value_count > 16:
            raise GeoTiffError(f"TIFF scalar/sample tag {tag} has an invalid value count")
        fmt = "H" if kind == 3 else "I"
        raw = data[value_offset:value_offset + total]
        if len(raw) != total:
            raise GeoTiffError("TIFF strip metadata is truncated")
        tags[tag] = (kind, list(struct.unpack(endian + fmt * value_count, raw)))
    return endian, tags, protected


def _numbers(
    tags: dict[int, tuple[int, Any]], tag: int, default: list[int] | None = None
) -> list[int]:
    item = tags.get(tag)
    if item is None:
        if default is None:
            raise GeoTiffError(f"TIFF is missing required strip/sample tag {tag}")
        return default
    kind, value = item
    if kind not in (3, 4) or not isinstance(value, list) or not all(
        isinstance(number, int) for number in value
    ):
        raise GeoTiffError(f"TIFF tag {tag} must contain integer values")
    return value


def calculate_geotiff_statistics(data: bytes) -> dict[str, Any]:
    """Calculate raw and, only when explicitly defined, scaled single-band stats."""
    metadata = inspect_geotiff(data)
    if len(data) > MAX_TIFF_BYTES:
        raise GeoTiffError("GeoTIFF exceeds the bounded statistics input limit")
    if metadata["pixel_count"] > MAX_STATISTICS_PIXELS:
        raise GeoTiffError("Raster exceeds the 10 million pixel statistics limit")
    endian, tags, protected_ranges = _entries(data)

    def one(tag: int, default: int | None = None) -> int:
        values = _numbers(tags, tag, [default] if default is not None else None)
        if len(values) != 1:
            raise GeoTiffError(f"TIFF tag {tag} must have exactly one value")
        return values[0]

    if one(259, 1) != 1:
        raise GeoTiffError("Only uncompressed TIFF strips are supported")
    if one(277, 1) != 1 or one(284, 1) != 1:
        raise GeoTiffError("Only single-band chunky TIFF rasters are supported")
    if one(317, 1) != 1:
        raise GeoTiffError("TIFF horizontal predictors are not supported")
    bits_values = _numbers(tags, 258, [1])
    sample_format = one(339, 1)
    if len(bits_values) != 1:
        raise GeoTiffError("Only one bit depth is supported")
    bits = bits_values[0]
    fmt = _FORMATS.get((sample_format, bits))
    if fmt is None:
        raise GeoTiffError("Unsupported TIFF sample format or bit depth")
    bytes_per_sample = bits // 8

    width, height = metadata["width"], metadata["height"]
    rows_per_strip = one(278, height)
    if rows_per_strip < 1:
        raise GeoTiffError("RowsPerStrip must be positive")
    offsets = _numbers(tags, 273)
    byte_counts = _numbers(tags, 279)
    strip_count = (height + rows_per_strip - 1) // rows_per_strip
    if strip_count > MAX_STRIPS:
        raise GeoTiffError("Raster requires more than 4,096 strips")
    if len(offsets) != strip_count or len(byte_counts) != strip_count:
        raise GeoTiffError("TIFF strip offsets/counts do not match image height")

    nodata = metadata["nodata"]
    nodata_value: float | None = None
    if nodata is not None:
        try:
            nodata_value = float(nodata)
        except (TypeError, ValueError) as exc:
            raise GeoTiffError("NoData value is not numeric for this raster") from exc
        if not math.isfinite(nodata_value):
            raise GeoTiffError("Non-finite NoData values are not supported")

    scale = metadata["scale"]
    offset = metadata["offset"]
    scaled_enabled = scale is not None and offset is not None
    if scaled_enabled and (not math.isfinite(scale) or not math.isfinite(offset)):
        raise GeoTiffError("Scale/offset must be finite")

    strip_ranges: list[tuple[int, int]] = []
    for strip_index, (strip_offset, strip_size) in enumerate(zip(offsets, byte_counts)):
        first_row = strip_index * rows_per_strip
        rows = min(rows_per_strip, height - first_row)
        expected = rows * width * bytes_per_sample
        if strip_size != expected or strip_offset < 0 or strip_offset + strip_size > len(data):
            raise GeoTiffError(
                f"TIFF strip byte range is invalid: offset={strip_offset}, bytes={strip_size}, "
                f"expected={expected}, file_bytes={len(data)}"
            )
        strip_range = (strip_offset, strip_offset + strip_size)
        if any(_overlaps(strip_range, protected) for protected in protected_ranges):
            raise GeoTiffError("TIFF pixel strip overlaps header, IFD or metadata values")
        strip_ranges.append(strip_range)
    ordered_ranges = sorted(strip_ranges)
    if any(
        ordered_ranges[index][0] < ordered_ranges[index - 1][1]
        for index in range(1, len(ordered_ranges))
    ):
        raise GeoTiffError("TIFF pixel strips overlap")

    valid_count = 0
    raw_min: int | float | None = None
    raw_max: int | float | None = None
    raw_mean = 0.0
    scaled_min: float | None = None
    scaled_max: float | None = None
    scaled_mean = 0.0

    for strip_start, strip_end in strip_ranges:
        raw = data[strip_start:strip_end]
        for (sample,) in struct.iter_unpack(endian + fmt, raw):
            value: int | float = sample if sample_format in (1, 2) else float(sample)
            if not math.isfinite(value):
                raise GeoTiffError("Raster contains a non-finite sample")
            if nodata_value is not None and value == nodata_value:
                continue
            previous_count = valid_count
            valid_count += 1
            raw_min = value if raw_min is None else min(raw_min, value)
            raw_max = value if raw_max is None else max(raw_max, value)
            numeric_value = float(value)
            raw_mean = math.fsum(
                (raw_mean * (previous_count / valid_count), numeric_value / valid_count)
            )
            if scaled_enabled:
                calibrated = numeric_value * scale + offset
                if not math.isfinite(calibrated):
                    raise GeoTiffError("Scaled raster sample exceeds the supported numeric range")
                scaled_min = calibrated if scaled_min is None else min(scaled_min, calibrated)
                scaled_max = calibrated if scaled_max is None else max(scaled_max, calibrated)
                scaled_mean = math.fsum(
                    (scaled_mean * (previous_count / valid_count), calibrated / valid_count)
                )

    pixel_count = metadata["pixel_count"]
    return {
        "width": width,
        "height": height,
        "pixel_count": pixel_count,
        "strip_count": strip_count,
        "rows_per_strip": rows_per_strip,
        "valid_pixel_count": valid_count,
        "nodata_pixel_count": pixel_count - valid_count,
        "raw_min": raw_min,
        "raw_max": raw_max,
        "raw_mean": raw_mean if valid_count else None,
        "scale_applied": bool(scaled_enabled),
        "scaled_min": scaled_min,
        "scaled_max": scaled_max,
        "scaled_mean": scaled_mean if valid_count and scaled_enabled else None,
        "bits_per_sample": bits,
        "sample_format": sample_format,
        "units": None,
        "evidence_class": "satellite_derived",
        "limitations": [
            "Statistics cover every decoded pixel in the supplied raster, not a study-area clip or zonal subset.",
            "NoData pixels are excluded; no spatial resampling or reprojection is performed.",
            "Scaled values are emitted only when both explicit GDAL scale and offset metadata are present.",
            "Units are not inferred; authoritative WaPOR layer metadata must supply them separately.",
            "Only single-band, uncompressed, chunky, classic TIFF strips without predictors are supported.",
        ],
    }
