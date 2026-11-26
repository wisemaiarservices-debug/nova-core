import struct

import pytest

from apps.api.services.geotiff_metadata import (
    GeoTiffError,
    MAX_TIFF_BYTES,
    MAX_GDAL_XML_BYTES,
    MAX_IFD_ENTRIES,
    MAX_METADATA_VALUES,
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
        elif field_type == 3:
            raw = struct.pack(endian + "H" * len(values), *values)
            count = len(values)
        elif field_type == 4:
            raw = struct.pack(endian + "I" * len(values), *values)
            count = len(values)
        elif field_type == 12:
            raw = struct.pack(endian + "d" * len(values), *values)
            count = len(values)
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
    tags = _basic_tags() + [(33550, 12, [1.0, 1.0, 0.0])]
    payload = bytearray(_tiff(tags))
    value_field_offset = 10 + (len(tags) - 1) * 12 + 8
    struct.pack_into("<I", payload, value_field_offset, 100000)
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


def test_rejects_nonfinite_geospatial_metadata():
    tags = _basic_tags() + [(33550, 12, [float("nan"), 1.0, 0.0])]
    with pytest.raises(GeoTiffError, match="non-finite"):
        inspect_geotiff(_tiff(tags))



def test_user_defined_geokey_is_not_mislabeled_as_epsg():
    tags = _basic_tags() + [
        (34735, 3, [1, 1, 0, 1, 3072, 0, 1, 32767]),
    ]
    result = inspect_geotiff(_tiff(tags))
    assert result["geo_reference"]["projected_epsg"] is None
    assert result["geo_reference"]["keys"]["3072"] == 32767


def test_reads_geokey_double_and_ascii_parameters():
    tags = _basic_tags() + [
        (34735, 3, [1, 1, 0, 2, 2050, 34736, 1, 0, 2049, 34737, 5, 0]),
        (34736, 12, [6378137.0]),
        (34737, 2, "WGS84|"),
    ]
    result = inspect_geotiff(_tiff(tags))
    assert result["geo_reference"]["keys"]["2050"] == 6378137.0
    assert result["geo_reference"]["keys"]["2049"] == "WGS84"


def test_rejects_duplicate_metadata_tags_and_wrong_known_field_types():
    with pytest.raises(GeoTiffError, match="duplicate"):
        inspect_geotiff(_tiff(_basic_tags() + [(256, 4, [10])]))
    tags = _basic_tags()
    tags[0] = (256, 3, [256])
    with pytest.raises(GeoTiffError, match="unexpected field type"):
        inspect_geotiff(_tiff(tags))


def test_rejects_excessive_ifd_entries_and_metadata_value_counts():
    with pytest.raises(GeoTiffError, match="too many entries"):
        inspect_geotiff(_tiff([(65000, 3, [1])] * (MAX_IFD_ENTRIES + 1)))
    tags = _basic_tags()
    tags[2] = (258, 3, [8] * (MAX_METADATA_VALUES + 1))
    with pytest.raises(GeoTiffError, match="too many values"):
        inspect_geotiff(_tiff(tags))


def test_rejects_unreasonable_pixel_count():
    tags = _basic_tags()
    tags[0] = (256, 4, [100000])
    tags[1] = (257, 4, [1001])
    with pytest.raises(GeoTiffError, match="pixel dimensions"):
        inspect_geotiff(_tiff(tags))


def test_validates_bits_sample_and_planar_metadata():
    tags = _basic_tags()
    tags[2] = (258, 3, [8, 16])
    with pytest.raises(GeoTiffError, match="bits-per-sample"):
        inspect_geotiff(_tiff(tags))
    tags = _basic_tags() + [(284, 3, [3])]
    with pytest.raises(GeoTiffError, match="planar configuration"):
        inspect_geotiff(_tiff(tags))


def test_validates_georeferencing_array_shapes():
    tags = _basic_tags() + [(33550, 12, [1.0, 1.0])]
    with pytest.raises(GeoTiffError, match="pixel scale"):
        inspect_geotiff(_tiff(tags))
    tags = _basic_tags() + [(34264, 12, [1.0] * 15)]
    with pytest.raises(GeoTiffError, match="16 values"):
        inspect_geotiff(_tiff(tags))
    tags = _basic_tags() + [(33922, 12, [1.0] * 7)]
    with pytest.raises(GeoTiffError, match="tiepoint"):
        inspect_geotiff(_tiff(tags))


def test_rejects_invalid_geokey_directory_and_duplicate_keys():
    tags = _basic_tags() + [(34735, 3, [2, 1, 0, 0])]
    with pytest.raises(GeoTiffError, match="version or key count"):
        inspect_geotiff(_tiff(tags))
    tags = _basic_tags() + [
        (34735, 3, [1, 1, 0, 2, 3072, 0, 1, 32632, 3072, 0, 1, 32633]),
    ]
    with pytest.raises(GeoTiffError, match="duplicate key"):
        inspect_geotiff(_tiff(tags))
    tags = _basic_tags() + [
        (34735, 3, [1, 1, 0, 1, 3072, 65000, 1, 32632]),
    ]
    with pytest.raises(GeoTiffError, match="unsupported TIFF directory"):
        inspect_geotiff(_tiff(tags))


def test_reads_gdal_scale_offset_but_rejects_entities_and_excessive_xml():
    xml = '<GDALMetadata><Item name="SCALE">0.1</Item><Item name="OFFSET">-9999</Item></GDALMetadata>'
    result = inspect_geotiff(_tiff(_basic_tags() + [(42112, 2, xml)]))
    assert result["scale"] == pytest.approx(0.1)
    assert result["offset"] == pytest.approx(-9999)

    entity = '<!DOCTYPE x [<!ENTITY a "boom">]><GDALMetadata>&a;</GDALMetadata>'
    with pytest.raises(GeoTiffError, match="declarations"):
        inspect_geotiff(_tiff(_basic_tags() + [(42112, 2, entity)]))
    too_large = "x" * (MAX_GDAL_XML_BYTES + 1)
    with pytest.raises(GeoTiffError, match="XML exceeds"):
        inspect_geotiff(_tiff(_basic_tags() + [(42112, 2, too_large)]))


def test_rejects_excessive_nodata_metadata_and_non_bytes_input():
    with pytest.raises(GeoTiffError, match="NoData"):
        inspect_geotiff(_tiff(_basic_tags() + [(42113, 2, "x" * 129)]))
    with pytest.raises(GeoTiffError, match="byte string"):
        inspect_geotiff(bytearray(_tiff(_basic_tags())))
