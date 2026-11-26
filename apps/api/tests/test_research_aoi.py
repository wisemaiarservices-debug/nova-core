import pytest

from apps.api.services.research_aoi import (
    AOIValidationError,
    MAX_AOI_GEOJSON_BYTES,
    MAX_POLYGONS,
    MAX_POSITIONS,
    MAX_RINGS_PER_POLYGON,
    canonical_research_aoi_sha256,
    validate_research_aoi,
)


def _polygon():
    return {
        "type": "Polygon",
        "coordinates": [[
            [10.0, 36.0], [10.2, 36.0], [10.2, 36.2],
            [10.0, 36.2], [10.0, 36.0],
        ]],
    }


def test_validates_explicit_wgs84_polygon_and_returns_bbox_without_site_identity():
    result = validate_research_aoi(_polygon())
    assert result["status"] == "structurally_valid"
    assert result["bbox"] == [10.0, 36.0, 10.2, 36.2]
    assert result["site_id"] is None
    assert result["position_count"] == 5
    assert "not polygon topology" in result["limitations"][0]


def test_accepts_multipolygon_and_hole_rings():
    first = _polygon()["coordinates"]
    second = [[[11, 36], [11.2, 36], [11.2, 36.2], [11, 36.2], [11, 36]]]
    result = validate_research_aoi({"type": "MultiPolygon", "coordinates": [first, second]})
    assert result["polygon_count"] == 2
    assert result["ring_count"] == 2


def test_normalizes_numeric_ring_closure_before_comparing_positions():
    geometry = {
        "type": "Polygon",
        "coordinates": [[
            [10, 36], (10.1, 36), [10.1, 36.1], [10, 36.1], (10.0, 36.0),
        ]],
    }
    assert validate_research_aoi(geometry)["position_count"] == 5


@pytest.mark.parametrize("geometry", [
    {"type": "Point", "coordinates": [10, 36]},
    {"type": "Polygon", "coordinates": [[[10, 36], [11, 36], [11, 37]]]},
    {"type": "Polygon", "coordinates": [[[10, 36], [11, 36], [12, 36], [10, 36]]]},
    {"type": "Polygon", "coordinates": [[[181, 36], [182, 36], [182, 37], [181, 36]]]},
    {"type": "Polygon", "coordinates": [[[10, 36], [float("nan"), 36], [11, 37], [10, 36]]]},
    {"type": "Polygon", "coordinates": [[[10, 36], [10, 36], [11, 37], [10, 36]]]},
    {"type": "Polygon", "coordinates": [[[10, 36, 0], [11, 36, 0], [11, 37, 0], [10, 36, 0]]]},
    {"type": "Polygon", "coordinates": [[[10, 36], [True, 36], [11, 37], [10, 36]]]},
])
def test_rejects_invalid_geometry_and_coordinates(geometry):
    with pytest.raises(AOIValidationError):
        validate_research_aoi(geometry)


def test_rejects_legacy_crs_override():
    geometry = _polygon()
    geometry["crs"] = {"type": "name", "properties": {"name": "EPSG:3857"}}
    with pytest.raises(AOIValidationError, match="CRS overrides"):
        validate_research_aoi(geometry)


def test_rejects_antimeridian_crossing_without_normalization():
    geometry = {
        "type": "Polygon",
        "coordinates": [[[179, 10], [-179, 10], [-179, 11], [179, 11], [179, 10]]],
    }
    with pytest.raises(AOIValidationError, match="Antimeridian"):
        validate_research_aoi(geometry)


def test_accepts_small_valid_polygon_without_arbitrary_area_epsilon():
    geometry = {
        "type": "Polygon",
        "coordinates": [[
            [10.0, 36.0], [10.0000001, 36.0], [10.0000001, 36.0000001],
            [10.0, 36.0000001], [10.0, 36.0],
        ]],
    }
    assert validate_research_aoi(geometry)["status"] == "structurally_valid"


def test_rejects_huge_integer_coordinates_without_leaking_overflow():
    geometry = {
        "type": "Polygon",
        "coordinates": [[
            [10**10000, 36], [11, 36], [11, 37], [10**10000, 36],
        ]],
    }
    with pytest.raises(AOIValidationError, match="finite numbers"):
        validate_research_aoi(geometry)


def test_enforces_polygon_ring_and_position_limits():
    polygon = _polygon()["coordinates"][0]
    with pytest.raises(AOIValidationError, match="polygon count"):
        validate_research_aoi({
            "type": "MultiPolygon",
            "coordinates": [[polygon] for _ in range(MAX_POLYGONS + 1)],
        })
    with pytest.raises(AOIValidationError, match="ring count|bounded exterior"):
        validate_research_aoi({
            "type": "Polygon",
            "coordinates": [polygon] * (MAX_RINGS_PER_POLYGON + 1),
        })
    many = [[float(index % 180), float((index // 180) % 80)] for index in range(MAX_POSITIONS + 1)]
    many[-1] = many[0]
    with pytest.raises(AOIValidationError, match="10,000-position"):
        validate_research_aoi({"type": "Polygon", "coordinates": [many]})


def test_rejects_collinear_and_consecutive_duplicate_ring_positions():
    collinear = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [1, 0], [2, 0], [0, 0]]],
    }
    with pytest.raises(AOIValidationError, match="zero planar area"):
        validate_research_aoi(collinear)



def test_canonical_aoi_hash_is_stable_across_object_key_order():
    first = _polygon()
    second = {"coordinates": first["coordinates"], "type": first["type"]}
    assert canonical_research_aoi_sha256(first) == canonical_research_aoi_sha256(second)


def test_canonical_aoi_hash_rejects_oversized_extra_metadata():
    geometry = _polygon()
    geometry["metadata"] = "x" * (MAX_AOI_GEOJSON_BYTES + 1)
    with pytest.raises(AOIValidationError, match="1 MiB"):
        canonical_research_aoi_sha256(geometry)


def test_canonical_aoi_hash_rejects_non_json_finite_values():
    geometry = _polygon()
    geometry["metadata"] = float("nan")
    with pytest.raises(AOIValidationError, match="finite"):
        canonical_research_aoi_sha256(geometry)
