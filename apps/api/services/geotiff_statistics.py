"""Bounded statistics for a deliberately narrow subset of classic GeoTIFF.

Supports single-band, uncompressed, chunky TIFF strips with predictor 1.
No network, decompression, reprojection, resampling, persistence or unit inference.
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
_FORMATS = {
    (1, 8): "B", (1, 16): "H", (1, 32): "I",
    (2, 8): "b", (2, 16): "h", (2, 32): "i",
    (3, 32): "f", (3, 64): "d",
}


def _entries(data: bytes) -> tuple[str, dict[int, tuple[int, list[int] | list[float] | str]]]:
    endian = "<" if data[:2] == b"II" else ">"
    offset = struct.unpack(endian + "I", data[4:8])[0]
    count = struct.unpack(endian + "H", data[offset:offset + 2])[0]
    tags: dict[int, tuple[int, list[int] | list[float] | str]] = {}
    formats = {1: ("B", 1), 2: ("s", 1), 3: ("H", 2), 4: ("I", 4), 11: ("f", 4), 12: ("d", 8)}
    for i in range(count):
        pos = offset + 2 + i * 12
        tag, kind, n = struct.unpack(endian + "HHI", data[pos:pos + 8])
        if kind not in formats:
            continue
        fmt, size = formats[kind]
        total = n * size
        start = pos + 8 if total <= 4 else struct.unpack(endian + "I", data[pos + 8:pos + 12])[0]
        if start + total > len(data):
            raise GeoTiffError("TIFF strip metadata points outside the bounded file")
        raw = data[start:start + total]
        if kind == 2:
            value: list[int] | list[float] | str = raw.split(b"\x00", 1)[0].decode("ascii", "strict")
        else:
            value = list(struct.unpack(endian + fmt * n, raw))
        tags[tag] = (kind, value)
    return endian, tags


def _numbers(tags: dict[int, tuple[int, Any]], tag: int, default: list[int] | None = None) -> list[int]:
    value = tags.get(tag, (4, default or []))[1]
    if not isinstance(value, list) or not all(isinstance(x, int) for x in value):
        raise GeoTiffError(f"TIFF tag {tag} must contain integer values")
    return value


def calculate_geotiff_statistics(data: bytes) -> dict[str, Any]:
    """Calculate raw and, only when explicitly defined, scaled single-band stats."""
    metadata = inspect_geotiff(data)
    if len(data) > MAX_TIFF_BYTES:
        raise GeoTiffError("GeoTIFF exceeds the bounded statistics input limit")
    if metadata["pixel_count"] > MAX_STATISTICS_PIXELS:
        raise GeoTiffError("Raster exceeds the 10 million pixel statistics limit")
    endian, tags = _entries(data)

    def one(tag: int, default: int) -> int:
        values = _numbers(tags, tag, [default])
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
    sample_values = _numbers(tags, 339, [1])
    if len(bits_values) != 1 or len(sample_values) != 1:
        raise GeoTiffError("Only one sample format and bit depth are supported")
    bits, sample_format = bits_values[0], sample_values[0]
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
    if len(offsets) != strip_count or len(byte_counts) != strip_count:
        raise GeoTiffError("TIFF strip offsets/counts do not match image height")

    nodata = metadata["nodata"]
    nodata_value: int | float | None = None
    if nodata is not None:
        try:
            nodata_value = float(nodata)
        except (TypeError, ValueError) as exc:
            raise GeoTiffError("NoData value is not numeric for this raster") from exc
        if not math.isfinite(nodata_value):
            raise GeoTiffError("Non-finite NoData values are not supported")

    total = 0
    minimum: float | None = None
    maximum: float | None = None
    value_sum = 0.0
    scaled_min: float | None = None
    scaled_max: float | None = None
    scaled_sum = 0.0
    scale = metadata["scale"]
    offset = metadata["offset"]
    scaled_enabled = scale is not None and offset is not None
    if scaled_enabled and (not math.isfinite(scale) or not math.isfinite(offset)):
        raise GeoTiffError("Scale/offset must be finite")

    for strip_index, (strip_offset, strip_size) in enumerate(zip(offsets, byte_counts)):
        first_row = strip_index * rows_per_strip
        rows = min(rows_per_strip, height - first_row)
        expected = rows * width * bytes_per_sample
        if strip_size != expected or strip_offset < 0 or strip_offset + strip_size > len(data):
            raise GeoTiffError("TIFF strip byte range is invalid or inconsistent with dimensions")
        raw = data[strip_offset:strip_offset + strip_size]
        values = struct.iter_unpack(endian + fmt, raw)
        for (sample,) in values:
            value = float(sample)
            if not math.isfinite(value):
                raise GeoTiffError("Raster contains a non-finite sample")
            if nodata_value is not None and value == nodata_value:
                continue
            total += 1
            minimum = value if minimum is None else min(minimum, value)
            maximum = value if maximum is None else max(maximum, value)
            value_sum += value
            if scaled_enabled:
                calibrated = value * scale + offset
                scaled_min = calibrated if scaled_min is None else min(scaled_min, calibrated)
                scaled_max = calibrated if scaled_max is None else max(scaled_max, calibrated)
                scaled_sum += calibrated

    result: dict[str, Any] = {
        "width": width,
        "height": height,
        "pixel_count": metadata["pixel_count"],
        "valid_pixel_count": total,
        "nodata_pixel_count": metadata["pixel_count"] - total,
        "raw_min": minimum,
        "raw_max": maximum,
        "raw_mean": value_sum / total if total else None,
        "scale_applied": bool(scaled_enabled),
        "scaled_min": scaled_min,
        "scaled_max": scaled_max,
        "scaled_mean": scaled_sum / total if total and scaled_enabled else None,
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
    return result
