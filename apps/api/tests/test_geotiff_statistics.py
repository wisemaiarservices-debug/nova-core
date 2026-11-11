import struct

import pytest

from apps.api.services.geotiff_metadata import GeoTiffError
from apps.api.services.geotiff_statistics import calculate_geotiff_statistics


def _strip_tiff(samples, *, compression=1, nodata="-9999", scale_xml=None):
    tags = [
        (256, 4, [2]), (257, 4, [2]), (258, 3, [16]),
        (259, 3, [compression]), (262, 3, [1]), (273, 4, [0]),
        (277, 3, [1]), (278, 4, [2]), (279, 4, [8]),
        (284, 3, [1]), (317, 3, [1]), (339, 3, [1]),
        (42113, 2, nodata),
    ]
    if scale_xml is not None:
        tags.append((42112, 2, scale_xml))
    ifd_offset = 8
    ifd_size = 2 + len(tags) * 12 + 4
    pixel_offset = ifd_offset + ifd_size
    entries = []
    external = bytearray()
    for tag, kind, values in tags:
        if kind == 2:
            raw = values.encode("ascii") + b"\x00"
            count = len(raw)
        elif kind == 3:
            raw = struct.pack("<" + "H" * len(values), *values)
            count = len(values)
        else:
            raw = struct.pack("<" + "I" * len(values), *values)
            count = len(values)
        if tag == 273:
            raw = struct.pack("<I", pixel_offset)
            count = 1
        if len(raw) <= 4:
            field = raw.ljust(4, b"\x00")
        else:
            field = struct.pack("<I", pixel_offset + len(external))
            external.extend(raw)
        entries.append(struct.pack("<HHI", tag, kind, count) + field)
    header = b"II" + struct.pack("<HI", 42, ifd_offset)
    ifd = struct.pack("<H", len(entries)) + b"".join(entries) + struct.pack("<I", 0)
    pixel_bytes = struct.pack("<" + "h" * len(samples), *samples)
    return header + ifd + external + pixel_bytes


def test_calculates_nodata_aware_raw_statistics():
    result = calculate_geotiff_statistics(_strip_tiff([1, 2, -9999, 5]))
    assert result["valid_pixel_count"] == 3
    assert result["nodata_pixel_count"] == 1
    assert result["raw_min"] == 1
    assert result["raw_max"] == 5
    assert result["raw_mean"] == pytest.approx(8 / 3)
    assert result["scaled_mean"] is None
    assert result["units"] is None
    assert result["evidence_class"] == "satellite_derived"


def test_all_nodata_returns_null_statistics_not_zero():
    result = calculate_geotiff_statistics(_strip_tiff([-9999] * 4))
    assert result["valid_pixel_count"] == 0
    assert result["raw_min"] is None
    assert result["raw_mean"] is None


def test_explicit_gdal_scale_and_offset_are_applied_only_when_both_exist():
    xml = '<GDALMetadata><Item name="scale">0.1</Item><Item name="offset">2</Item></GDALMetadata>'
    result = calculate_geotiff_statistics(_strip_tiff([10, 20, 30, 40], nodata="-9999", scale_xml=xml))
    assert result["scale_applied"] is True
    assert result["scaled_min"] == pytest.approx(3)
    assert result["scaled_max"] == pytest.approx(6)
    assert result["scaled_mean"] == pytest.approx(4.5)


def test_rejects_compressed_strips_instead_of_returning_wrong_statistics():
    with pytest.raises(GeoTiffError, match="uncompressed"):
        calculate_geotiff_statistics(_strip_tiff([1, 2, 3, 4], compression=8))
