"""Bounded, offline GeoTIFF metadata inspection for WaPOR research assets.

This parser reads TIFF headers and IFD metadata only. It never decodes raster
pixels, follows URLs, writes files, or infers units from a layer name.
"""
from __future__ import annotations

import math
import struct
import xml.etree.ElementTree as ET
from typing import Any

MAX_TIFF_BYTES = 16 * 1024 * 1024
MAX_IFD_ENTRIES = 512
MAX_DIMENSION = 100_000
MAX_PIXEL_COUNT = 100_000_000

_TYPE_FORMATS = {
    1: ("B", 1), 2: ("s", 1), 3: ("H", 2), 4: ("I", 4),
    5: ("II", 8), 6: ("b", 1), 7: ("B", 1), 8: ("h", 2),
    9: ("i", 4), 10: ("ii", 8), 11: ("f", 4), 12: ("d", 8),
}


class GeoTiffError(ValueError):
    """Raised when a TIFF header or metadata structure is unsafe or invalid."""


def _read_values(data: bytes, endian: str, field_type: int, count: int, offset: int) -> list[Any]:
    if field_type not in _TYPE_FORMATS:
        raise GeoTiffError("TIFF contains an unsupported field type")
    fmt, type_size = _TYPE_FORMATS[field_type]
    total = type_size * count
    if count > 1_000_000 or offset < 0 or offset + total > len(data):
        raise GeoTiffError("TIFF metadata value points outside the bounded file")
    if field_type == 2:
        return [data[offset:offset + total].split(b"\x00", 1)[0].decode("ascii", "replace")]
    if field_type in (5, 10):
        component = "I" if field_type == 5 else "i"
        raw = struct.unpack(endian + component * (count * 2), data[offset:offset + total])
        values = []
        for index in range(0, len(raw), 2):
            denominator = raw[index + 1]
            values.append(None if denominator == 0 else raw[index] / denominator)
        return values
    values = list(struct.unpack(endian + fmt * count, data[offset:offset + total]))
    if field_type in (11, 12) and not all(math.isfinite(value) for value in values):
        raise GeoTiffError("TIFF floating-point metadata contains a non-finite value")
    return values


def _geo_keys(values: list[Any], doubles: list[Any], ascii_params: str) -> dict[str, Any]:
    if len(values) < 4:
        raise GeoTiffError("GeoKeyDirectory is truncated")
    version, revision, minor, count = values[:4]
    if count > 256 or len(values) != 4 + count * 4:
        raise GeoTiffError("GeoKeyDirectory has an invalid key count")
    keys: dict[str, Any] = {}
    for index in range(count):
        key_id, location, item_count, value_offset = values[4 + index * 4:8 + index * 4]
        if location == 0:
            value: Any = value_offset
        elif location == 34736:
            if value_offset + item_count > len(doubles):
                raise GeoTiffError("GeoKey double parameter points outside metadata")
            selected = doubles[value_offset:value_offset + item_count]
            value = selected[0] if item_count == 1 else selected
        elif location == 34737:
            if value_offset + item_count > len(ascii_params):
                raise GeoTiffError("GeoKey ASCII parameter points outside metadata")
            value = ascii_params[value_offset:value_offset + item_count].rstrip("|\x00")
        else:
            raise GeoTiffError("GeoKey references an unsupported TIFF directory")
        keys[str(key_id)] = value
    return {
        "directory_version": version,
        "revision": revision,
        "minor_revision": minor,
        "keys": keys,
        "geographic_epsg": keys.get("2048"),
        "projected_epsg": keys.get("3072"),
        "raster_type": keys.get("1025"),
        "geographic_citation": keys.get("2049"),
        "projected_citation": keys.get("3073"),
    }


def _gdal_scale_offset(xml_text: str | None) -> dict[str, float | None]:
    result: dict[str, float | None] = {"scale": None, "offset": None}
    if not xml_text:
        return result
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return result
    for item in root.iter("Item"):
        name = item.attrib.get("name", "").lower()
        if name in result and item.text:
            try:
                number = float(item.text.strip())
            except ValueError:
                continue
            result[name] = number if math.isfinite(number) else None
    return result


def inspect_geotiff(data: bytes) -> dict[str, Any]:
    """Inspect a bounded classic TIFF/GeoTIFF byte string without reading pixels."""
    if not isinstance(data, bytes) or len(data) < 8:
        raise GeoTiffError("Input is not a complete TIFF byte string")
    if len(data) > MAX_TIFF_BYTES:
        raise GeoTiffError("GeoTIFF exceeds the 16 MiB metadata-inspection limit")
    marker = data[:2]
    if marker == b"II":
        endian = "<"
    elif marker == b"MM":
        endian = ">"
    else:
        raise GeoTiffError("Invalid TIFF byte-order marker")
    magic = struct.unpack(endian + "H", data[2:4])[0]
    if magic == 43:
        raise GeoTiffError("BigTIFF is not supported by this bounded metadata parser")
    if magic != 42:
        raise GeoTiffError("Invalid TIFF magic number")
    ifd_offset = struct.unpack(endian + "I", data[4:8])[0]
    if ifd_offset < 8 or ifd_offset + 2 > len(data):
        raise GeoTiffError("TIFF first IFD offset is outside the file")
    entry_count = struct.unpack(endian + "H", data[ifd_offset:ifd_offset + 2])[0]
    if entry_count > MAX_IFD_ENTRIES:
        raise GeoTiffError("TIFF IFD contains too many entries")
    if ifd_offset + 2 + entry_count * 12 + 4 > len(data):
        raise GeoTiffError("TIFF IFD is truncated")

    tags: dict[int, Any] = {}
    for index in range(entry_count):
        start = ifd_offset + 2 + index * 12
        tag, field_type, count = struct.unpack(endian + "HHI", data[start:start + 8])
        value_field = data[start + 8:start + 12]
        if field_type not in _TYPE_FORMATS:
            continue
        type_size = _TYPE_FORMATS[field_type][1]
        total = type_size * count
        value_offset = start + 8 if total <= 4 else struct.unpack(endian + "I", value_field)[0]
        values = _read_values(data, endian, field_type, count, value_offset)
        tags[tag] = values[0] if field_type == 2 else values

    def scalar(tag: int, default: Any = None) -> Any:
        value = tags.get(tag, default)
        return value[0] if isinstance(value, list) and value else value

    width = scalar(256)
    height = scalar(257)
    if not isinstance(width, int) or not isinstance(height, int):
        raise GeoTiffError("GeoTIFF is missing valid image width or height")
    if width < 1 or height < 1 or width > MAX_DIMENSION or height > MAX_DIMENSION:
        raise GeoTiffError("GeoTIFF dimensions exceed supported bounds")
    if width * height > MAX_PIXEL_COUNT:
        raise GeoTiffError("GeoTIFF pixel dimensions exceed metadata inspection limits")

    bits = tags.get(258, [])
    samples = scalar(277, 1)
    if not isinstance(samples, int) or samples < 1 or samples > 16:
        raise GeoTiffError("GeoTIFF samples-per-pixel value is invalid")

    geo_keys = None
    if 34735 in tags:
        geo_keys = _geo_keys(tags[34735], tags.get(34736, []), scalar(34737, "") or "")

    scale_offset = _gdal_scale_offset(scalar(42112))
    nodata = scalar(42113)
    if isinstance(nodata, str):
        nodata = nodata.strip()

    return {
        "format": "TIFF/GeoTIFF",
        "byte_order": "little" if endian == "<" else "big",
        "width": width,
        "height": height,
        "pixel_count": width * height,
        "samples_per_pixel": samples,
        "bits_per_sample": bits,
        "compression": scalar(259),
        "photometric_interpretation": scalar(262),
        "planar_configuration": scalar(284),
        "predictor": scalar(317),
        "sample_format": tags.get(339),
        "model_pixel_scale": tags.get(33550),
        "model_tiepoint": tags.get(33922),
        "model_transformation": tags.get(34264),
        "geo_reference": geo_keys,
        "nodata": nodata,
        **scale_offset,
        "units": None,
        "pixel_values_read": False,
        "limitations": [
            "Metadata only: no raster pixels were decoded or sampled.",
            "CRS is reported only when the GeoKeyDirectory explicitly supplies an EPSG key.",
            "Units must come from authoritative WaPOR layer metadata, not inferred from TIFF tags or layer names.",
            "Scale and offset are reported only when present in GDAL metadata; absence does not imply identity scaling.",
            "Bounds are not calculated unless a later geospatial transform implementation validates the full GeoTIFF georeferencing model.",
            "This parser supports classic TIFF only; BigTIFF and non-standard private tags are not interpreted.",
        ],
    }
