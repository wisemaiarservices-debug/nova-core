import struct

import pytest

from apps.api.services.geotiff_metadata import GeoTiffError
from apps.api.services.geotiff_statistics import calculate_geotiff_statistics


def _strip_tiff(samples, *, compression=1, nodata="-9999", scale_xml=None):
    tags = [
        (256, 4, [2]), (257, 4, [2]), (258, 3, [16]),
        (259, 3, [compression]), (262, 3, [1]), (273, 4, [0]),
        (277, 3, [1]), (278, 4, [2]), (279, 4, [8]),
        (284, 3, [1]), (317, 3, [1]), (339, 3, [2]),
        (42113, 2, nodata),
    ]
    if scale_xml is not None:
        tags.append((42112, 2, scale_xml))
    ifd_offset = 8
    ifd_size = 2 + len(tags) * 12 + 4
    external_size = sum(
        len(value.encode("ascii") + b"\x00")
        for tag, kind, value in tags if kind == 2
    )
    external_offset = ifd_offset + ifd_size
    pixel_offset = external_offset + external_size
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
            field = struct.pack("<I", external_offset + len(external))
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



def _multi_strip_tiff(samples, *, width=2, rows_per_strip=1, overlap=False):
    height = len(samples) // width
    assert height * width == len(samples)
    strip_count = (height + rows_per_strip - 1) // rows_per_strip
    counts = [
        min(rows_per_strip, height - index * rows_per_strip) * width * 2
        for index in range(strip_count)
    ]
    offsets = [0] * strip_count
    tags = [
        (256, 4, [width]), (257, 4, [height]), (258, 3, [16]),
        (259, 3, [1]), (262, 3, [1]), (273, 4, offsets),
        (277, 3, [1]), (278, 4, [rows_per_strip]), (279, 4, counts),
        (284, 3, [1]), (317, 3, [1]), (339, 3, [2]), (42113, 2, "-9999"),
    ]
    ifd_offset = 8
    ifd_end = ifd_offset + 2 + len(tags) * 12 + 4
    external_size = len("-9999".encode("ascii") + b"\x00") + 8 * 2
    pixel_offset = ifd_end + external_size
    if overlap:
        offsets = [pixel_offset] * strip_count
    else:
        cursor = pixel_offset
        offsets = []
        for count in counts:
            offsets.append(cursor)
            cursor += count
    tags[5] = (273, 4, offsets)
    entries = []
    external = bytearray()
    external_offset = ifd_end
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
        if len(raw) <= 4:
            field = raw.ljust(4, b"\x00")
        else:
            field = struct.pack("<I", external_offset + len(external))
            external.extend(raw)
        entries.append(struct.pack("<HHI", tag, kind, count) + field)
    header = b"II" + struct.pack("<HI", 42, ifd_offset)
    ifd = struct.pack("<H", len(entries)) + b"".join(entries) + struct.pack("<I", 0)
    pixel_bytes = struct.pack("<" + "h" * len(samples), *samples)
    return header + ifd + external + pixel_bytes


def _float64_strip_tiff(samples, *, scale_xml=None):
    tags = [
        (256, 4, [2]), (257, 4, [2]), (258, 3, [64]),
        (259, 3, [1]), (262, 3, [1]), (273, 4, [0]),
        (277, 3, [1]), (278, 4, [2]), (279, 4, [8 * len(samples)]),
        (284, 3, [1]), (317, 3, [1]), (339, 3, [3]),
        (42113, 2, "-9999"),
    ]
    if scale_xml is not None:
        tags.append((42112, 2, scale_xml))
    ifd_offset = 8
    ifd_size = 2 + len(tags) * 12 + 4
    external_size = sum(
        len(values.encode("ascii") + b"\x00")
        for tag, kind, values in tags if kind == 2
    )
    external_offset = ifd_offset + ifd_size
    pixel_offset = external_offset + external_size
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
        if len(raw) <= 4:
            field = raw.ljust(4, b"\x00")
        else:
            field = struct.pack("<I", external_offset + len(external))
            external.extend(raw)
        entries.append(struct.pack("<HHI", tag, kind, count) + field)
    header = b"II" + struct.pack("<HI", 42, ifd_offset)
    ifd = struct.pack("<H", len(entries)) + b"".join(entries) + struct.pack("<I", 0)
    pixel_bytes = struct.pack("<" + "d" * len(samples), *samples)
    return header + ifd + external + pixel_bytes


def _mutate_inline_tag_value(payload, tag, value):
    data = bytearray(payload)
    ifd_offset = struct.unpack("<I", data[4:8])[0]
    count = struct.unpack("<H", data[ifd_offset:ifd_offset + 2])[0]
    for index in range(count):
        pos = ifd_offset + 2 + index * 12
        current = struct.unpack("<H", data[pos:pos + 2])[0]
        if current == tag:
            struct.pack_into("<I", data, pos + 8, value)
            return bytes(data)
    raise AssertionError(tag)


def test_supports_multiple_non_overlapping_strips():
    result = calculate_geotiff_statistics(_multi_strip_tiff([1, 2, 3, 4]))
    assert result["strip_count"] == 2
    assert result["rows_per_strip"] == 1
    assert result["raw_min"] == 1
    assert result["raw_max"] == 4
    assert result["raw_mean"] == pytest.approx(2.5)


def test_rejects_overlapping_strips_and_strips_inside_metadata():
    with pytest.raises(GeoTiffError, match="strips overlap"):
        calculate_geotiff_statistics(_multi_strip_tiff([1, 2, 3, 4], overlap=True))
    payload = _strip_tiff([1, 2, 3, 4])
    ifd_offset = struct.unpack("<I", payload[4:8])[0]
    ifd_end = ifd_offset + 2 + struct.unpack("<H", payload[ifd_offset:ifd_offset + 2])[0] * 12 + 4
    with pytest.raises(GeoTiffError, match="overlaps header, IFD or metadata"):
        calculate_geotiff_statistics(_mutate_inline_tag_value(payload, 273, ifd_end))


def test_rejects_duplicate_strip_tags_and_mismatched_byte_counts():
    payload = bytearray(_strip_tiff([1, 2, 3, 4]))
    ifd_offset = struct.unpack("<I", payload[4:8])[0]
    count = struct.unpack("<H", payload[ifd_offset:ifd_offset + 2])[0]
    for index in range(count):
        pos = ifd_offset + 2 + index * 12
        if struct.unpack("<H", payload[pos:pos + 2])[0] == 42113:
            struct.pack_into("<H", payload, pos, 273)
            break
    with pytest.raises(GeoTiffError, match="duplicate tag"):
        calculate_geotiff_statistics(bytes(payload))
    with pytest.raises(GeoTiffError, match="byte range is invalid"):
        calculate_geotiff_statistics(_mutate_inline_tag_value(_strip_tiff([1, 2, 3, 4]), 279, 7))


def test_rejects_more_than_4096_strips_and_multi_ifd_tiff():
    with pytest.raises(GeoTiffError, match="4,096-strip"):
        calculate_geotiff_statistics(_multi_strip_tiff(list(range(4097)), width=1))
    payload = bytearray(_strip_tiff([1, 2, 3, 4]))
    ifd_offset = struct.unpack("<I", payload[4:8])[0]
    count = struct.unpack("<H", payload[ifd_offset:ifd_offset + 2])[0]
    struct.pack_into("<I", payload, ifd_offset + 2 + count * 12, 8)
    with pytest.raises(GeoTiffError, match="Multi-image"):
        calculate_geotiff_statistics(bytes(payload))


def test_rejects_nonfinite_samples_and_scaled_overflow():
    with pytest.raises(GeoTiffError, match="non-finite sample"):
        calculate_geotiff_statistics(_float64_strip_tiff([float("nan"), 1.0, 2.0, 3.0]))
    xml = '<GDALMetadata><Item name="scale">2</Item><Item name="offset">0</Item></GDALMetadata>'
    with pytest.raises(GeoTiffError, match="Scaled raster sample"):
        calculate_geotiff_statistics(_float64_strip_tiff([1e308] * 4, scale_xml=xml))


def test_mean_accumulation_is_stable_for_large_finite_float_samples():
    result = calculate_geotiff_statistics(_float64_strip_tiff([1e308] * 4))
    assert result["raw_min"] == 1e308
    assert result["raw_max"] == 1e308
    assert result["raw_mean"] == pytest.approx(1e308)
