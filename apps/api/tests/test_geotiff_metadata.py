import struct

import pytest

from apps.api.services.geotiff_metadata import (
    GeoTiffError,
    MAX_TIFF_BYTES,
    inspect_geotiff,
)


def _tiff(tags, *, endian="<"):
    entries = []
    external = bytearray()
    ifd_offset = 8
    ifd_size = 2 + len(tags) * 12 + 4
    data_offset = ifd_offset + ifd_size
    for tag, field_type, values in tags:
        if field_type == 2:
            raw = values.encode("ascii") + b"\x00"
            count = len(raw)
            inline = raw
        elif field_type == 3:
            raw = struct.pack(endian + "H" * len(values), *values)
            count = len(values)
            inline = raw
        elif field_type == 4:
            raw = struct.pack(endian + "I" * len(values), *values)
            count = len(values)
            inline = raw
        elif field_type == 12:
            raw = struct.pack(endian + "d" * len(values), *values)
            count = len(values)
            inline = raw
        else:
            raise AssertionError(field_type)
        if len(raw) <= 4:
            value_field = raw.ljust(4, b"\x00")
        else:
            value_field = struct.pack(endian + "I", data_offset + len(external))
            external.extend(raw)
        entries.append(struct.pack(endian + "HHI", tag, field_type, count) + value_field)
    header = (b"II" if endian == "<" else b"MM") + struct.pack(endian + "HI", 42, ifd_offset)
    ifd = struct.pack(endian + "H", len(entries)) + b"".join(entries) + struct.pack(endian + "I", 0)
    return header + ifd + external


def _basic_tags():
    return [
        (256, 4, [256]),
        (257, 4, [128]),
        (258, 3, [16]),
        (259, 3, [8]),
        (262, 3, [1]),
        (277, 3, [1]),
        (339, 3, [1]),
        (42113, 2, "-9999"),
    ]


def test_inspects_little_endian_classic_tiff_metadata_without_reading_pixels():
    result = inspect_geotiff(_tiff(_basic_tags()))
    assert result["format"] == "TIFF/GeoTIFF"
    assert result["width"] == 256
    assert result["height"] == 128
    assert result["pixel_count"] == 32768
    assert result["bits_per_sample"] == [16]
    assert result["compression"] == 8
    assert result["sample_format"] == [1]
    assert result["nodata"] == "-9999"
    assert result["pixel_values_read"] is False
    assert result["units"] is None


def test_inspects_big_endian_tiff():
    result = inspect_geotiff(_tiff(_basic_tags(), endian=">"))
    assert result["byte_order"] == "big"
    assert result["width"] == 256


def test_extracts_explicit_epsg_from_geokey_directory():
    tags = _basic_tags() + [
        (34735, 3, [1, 1, 0, 1, 3072, 0, 1, 32632]),
    ]
    result = inspect_geotiff(_tiff(tags))
    assert result["geo_reference"]["projected_epsg"] == 32632


def test_rejects_non_tiff_and_truncated_ifd():
    with pytest.raises(GeoTiffError, match="byte-order"):
        inspect_geotiff(b"NOPE1234")
    with pytest.raises(GeoTiffError, match="IFD"):
        inspect_geotiff(b"II" + struct.pack("<HI", 42, 999))


def test_rejects_bigtiff_until_supported_explicitly():
    payload = b"II" + struct.pack("<HI", 43, 8) + b"\x08\x00\x00\x00"
    with pytest.raises(GeoTiffError, match="BigTIFF"):
        inspect_geotiff(payload)


def test_rejects_metadata_offsets_outside_input():
    payload = bytearray(_tiff(_basic_tags()))
    # Point the width entry at an offset beyond the end of the file.
    struct.pack_into("<I", payload, 18, 100000)
    with pytest.raises(GeoTiffError, match="outside"):
        inspect_geotiff(bytes(payload))


def test_rejects_unreasonable_dimensions():
    tags = _basic_tags()
    tags[0] = (256, 4, [100001])
    with pytest.raises(GeoTiffError, match="dimensions"):
        inspect_geotiff(_tiff(tags))


def test_rejects_oversized_input_before_parsing():
    with pytest.raises(GeoTiffError, match="16 MiB"):
        inspect_geotiff(b"II" + b"\x00" * (MAX_TIFF_BYTES + 1))
