"""Bounded, offline GeoTIFF metadata inspection for WaPOR research assets.

The parser reads only the classic TIFF header and first IFD metadata. It never
decodes pixels, follows URLs, writes files, or infers units from a layer name.
"""
from __future__ import annotations

import math
import re
import struct
import xml.etree.ElementTree as ET
from typing import Any

MAX_TIFF_BYTES = 16 * 1024 * 1024
MAX_IFD_ENTRIES = 512
MAX_METADATA_VALUES = 4096
MAX_GDAL_XML_BYTES = 1024 * 1024
MAX_GDAL_XML_ELEMENTS = 4096
MAX_ASCII_BYTES = 64 * 1024
MAX_DIMENSION = 100_000
MAX_PIXEL_COUNT = 100_000_000

_TYPE_FORMATS = {
    1: ("B", 1), 2: ("s", 1), 3: ("H", 2), 4: ("I", 4),
    5: ("II", 8), 6: ("b", 1), 7: ("B", 1), 8: ("h", 2),
    9: ("i", 4), 10: ("ii", 8), 11: ("f", 4), 12: ("d", 8),
}
_METADATA_TAGS = {
    256, 257, 258, 259, 262, 277, 284, 317, 339,
    33550, 33922, 34264, 34735, 34736, 34737, 42112, 42113,
}
_EXPECTED_TYPES = {
    256: {3, 4}, 257: {3, 4}, 258: {3}, 259: {3}, 262: {3},
    277: {3}, 284: {3}, 317: {3}, 339: {3},
    33550: {12}, 33922: {12}, 34264: {12},
    34735: {3}, 34736: {12}, 34737: {2},
    42112: {2}, 42113: {2},
}


class GeoTiffError(ValueError):
    """Raised when a TIFF header or metadata structure is unsafe or invalid."""


def _read_values(
    data: bytes, endian: str, field_type: int, count: int, offset: int, *,
    max_count: int = MAX_METADATA_VALUES,
) -> list[Any]:
    if field_type not in _TYPE_FORMATS:
        raise GeoTiffError("TIFF contains an unsupported field type")
    if count < 0 or count > max_count:
        raise GeoTiffError("TIFF metadata field contains too many values")
    fmt, type_size = _TYPE_FORMATS[field_type]
    total = type_size * count
    if offset < 0 or offset + total > len(data):
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


def _valid_epsg(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and 0 < value <= 999_999 and value != 32767:
        return value
    return None


def _geo_keys(values: list[Any], doubles: list[Any], ascii_params: str) -> dict[str, Any]:
    if len(values) < 4 or not all(isinstance(value, int) for value in values):
        raise GeoTiffError("GeoKeyDirectory is truncated or has invalid field types")
    version, revision, minor, count = values[:4]
    if version != 1 or count > 256 or len(values) != 4 + count * 4:
        raise GeoTiffError("GeoKeyDirectory has an invalid version or key count")
    keys: dict[str, Any] = {}
    for index in range(count):
        key_id, location, item_count, value_offset = values[4 + index * 4:8 + index * 4]
        if key_id <= 0 or key_id in keys or item_count < 1:
            raise GeoTiffError("GeoKeyDirectory contains an invalid or duplicate key")
        if location == 0:
            if item_count != 1:
                raise GeoTiffError("Inline GeoKey values must contain exactly one item")
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
        keys[key_id] = value
    return {
        "directory_version": version,
        "revision": revision,
        "minor_revision": minor,
        "keys": {str(key): value for key, value in keys.items()},
        "geographic_epsg": _valid_epsg(keys.get(2048)),
        "projected_epsg": _valid_epsg(keys.get(3072)),
        "raster_type": keys.get(1025),
        "geographic_citation": keys.get(2049),
        "projected_citation": keys.get(3073),
    }


def _gdal_scale_offset(xml_text: str | None) -> dict[str, float | None]:
    result: dict[str, float | None] = {"scale": None, "offset": None}
    if not xml_text:
        return result
    if len(xml_text.encode("utf-8")) > MAX_GDAL_XML_BYTES:
        raise GeoTiffError("GDAL metadata XML exceeds its inspection limit")
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)", xml_text, re.IGNORECASE):
        raise GeoTiffError("GDAL metadata XML declarations are not supported")
    if xml_text.count("<") > MAX_GDAL_XML_ELEMENTS:
        raise GeoTiffError("GDAL metadata XML contains too many elements")
    try:
        root = ET.fromstring(xml_text)
    except (ET.ParseError, RecursionError) as exc:
        raise GeoTiffError("GDAL metadata XML is malformed or too deeply nested") from exc
    candidates: dict[str, list[float]] = {"scale": [], "offset": []}
    for item in root.iter("Item"):
        name = item.attrib.get("name", "").lower()
        if name in candidates and item.text:
            try:
                number = float(item.text.strip())
            except ValueError:
                continue
            if math.isfinite(number):
                candidates[name].append(number)
    for name, values in candidates.items():
        if values and all(value == values[0] for value in values):
            result[name] = values[0]
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

    tags: dict[int, tuple[int, Any]] = {}
    for index in range(entry_count):
        start = ifd_offset + 2 + index * 12
        tag, field_type, count = struct.unpack(endian + "HHI", data[start:start + 8])
        if tag not in _METADATA_TAGS:
            continue
        if tag in tags:
            raise GeoTiffError("TIFF contains a duplicate metadata tag")
        if field_type not in _EXPECTED_TYPES[tag]:
            raise GeoTiffError("TIFF metadata tag has an unexpected field type")
        if field_type == 2:
            max_count = MAX_GDAL_XML_BYTES if tag == 42112 else MAX_ASCII_BYTES
        else:
            max_count = MAX_METADATA_VALUES
        type_size = _TYPE_FORMATS[field_type][1]
        total = type_size * count
        value_field = data[start + 8:start + 12]
        value_offset = start + 8 if total <= 4 else struct.unpack(endian + "I", value_field)[0]
        values = _read_values(
            data, endian, field_type, count, value_offset, max_count=max_count
        )
        value: Any = values[0] if field_type == 2 else values
        tags[tag] = (field_type, value)

    def values(tag: int, default: list[Any] | None = None) -> list[Any]:
        item = tags.get(tag)
        return item[1] if item is not None else (default or [])

    def scalar(tag: int, default: Any = None) -> Any:
        item = tags.get(tag)
        if item is None:
            return default
        value = item[1]
        if isinstance(value, list):
            if len(value) != 1:
                raise GeoTiffError("TIFF scalar metadata tag must contain exactly one value")
            return value[0]
        return value

    width = scalar(256)
    height = scalar(257)
    if not isinstance(width, int) or not isinstance(height, int):
        raise GeoTiffError("GeoTIFF is missing valid image width or height")
    if width < 1 or height < 1 or width > MAX_DIMENSION or height > MAX_DIMENSION:
        raise GeoTiffError("GeoTIFF dimensions exceed supported bounds")
    if width * height > MAX_PIXEL_COUNT:
        raise GeoTiffError("GeoTIFF pixel dimensions exceed metadata inspection limits")

    samples = scalar(277, 1)
    if not isinstance(samples, int) or samples < 1 or samples > 16:
        raise GeoTiffError("GeoTIFF samples-per-pixel value is invalid")
    bits = values(258)
    if bits and (
        len(bits) not in (1, samples)
        or any(not isinstance(bit, int) or bit < 1 or bit > 64 for bit in bits)
    ):
        raise GeoTiffError("GeoTIFF bits-per-sample values are invalid")
    sample_format = values(339)
    if sample_format and (
        len(sample_format) not in (1, samples)
        or any(value not in (1, 2, 3, 4) for value in sample_format)
    ):
        raise GeoTiffError("GeoTIFF sample-format values are invalid")
    planar = scalar(284, 1)
    if planar not in (1, 2):
        raise GeoTiffError("GeoTIFF planar configuration is invalid")

    pixel_scale = values(33550)
    if pixel_scale and (
        len(pixel_scale) != 3
        or pixel_scale[0] <= 0
        or pixel_scale[1] <= 0
        or pixel_scale[2] < 0
    ):
        raise GeoTiffError("GeoTIFF model pixel scale is invalid")
    tiepoints = values(33922)
    if tiepoints and (len(tiepoints) % 6 != 0 or len(tiepoints) > 1024):
        raise GeoTiffError("GeoTIFF model tiepoint metadata is invalid")
    transformation = values(34264)
    if transformation and len(transformation) != 16:
        raise GeoTiffError("GeoTIFF model transformation must contain 16 values")

    geo_keys = None
    if 34735 in tags:
        geo_keys = _geo_keys(
            values(34735),
            values(34736),
            scalar(34737, "") or "",
        )

    scale_offset = _gdal_scale_offset(scalar(42112))
    nodata = scalar(42113)
    if isinstance(nodata, str):
        nodata = nodata.strip()
        if len(nodata) > 128:
            raise GeoTiffError("GDAL NoData metadata exceeds its inspection limit")

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
        "planar_configuration": planar,
        "predictor": scalar(317),
        "sample_format": sample_format,
        "model_pixel_scale": pixel_scale or None,
        "model_tiepoint": tiepoints or None,
        "model_transformation": transformation or None,
        "geo_reference": geo_keys,
        "nodata": nodata,
        **scale_offset,
        "units": None,
        "pixel_values_read": False,
        "limitations": [
            "Metadata only: no raster pixels were decoded or sampled.",
            "CRS is reported only for explicit non-user-defined EPSG GeoKey values.",
            "Units must come from authoritative WaPOR layer metadata, not inferred from TIFF tags or layer names.",
            "Scale and offset are reported only when present in GDAL metadata; absence does not imply identity scaling.",
            "Bounds are not calculated unless a later geospatial transform implementation validates the full GeoTIFF georeferencing model.",
            "This parser supports classic TIFF only; BigTIFF and non-standard private tags are not interpreted.",
        ],
    }
