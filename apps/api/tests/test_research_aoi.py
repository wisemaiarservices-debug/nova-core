import pytest

from apps.api.services.research_aoi import AOIValidationError, validate_research_aoi


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


def test_accepts_multipolygon_and_hole_rings():
    first = _polygon()["coordinates"]
    second = [[[11, 36], [11.2, 36], [11.2, 36.2], [11, 36.2], [11, 36]]]
    result = validate_research_aoi({"type": "MultiPolygon", "coordinates": [first, second]})
    assert result["polygon_count"] == 2
    assert result["ring_count"] == 2


@pytest.mark.parametrize("geometry", [
    {"type": "Point", "coordinates": [10, 36]},
    {"type": "Polygon", "coordinates": [[[10, 36], [11, 36], [11, 37]]]},
    {"type": "Polygon", "coordinates": [[[10, 36], [11, 36], [12, 36], [10, 36]]]},
    {"type": "Polygon", "coordinates": [[[181, 36], [182, 36], [182, 37], [181, 36]]]},
    {"type": "Polygon", "coordinates": [[[10, 36], [float("nan"), 36], [11, 37], [10, 36]]]},
    {"type": "Polygon", "coordinates": [[[10, 36], [10, 36], [11, 37], [10, 36]]]},
])
def test_rejects_invalid_geometry_and_coordinates(geometry):
    with pytest.raises(AOIValidationError):
        validate_research_aoi(geometry)


def test_rejects_antimeridian_crossing_without_normalization():
    geometry = {"type": "Polygon", "coordinates": [[[179, 10], [-179, 10], [-179, 11], [179, 11], [179, 10]]]}
    with pytest.raises(AOIValidationError, match="Antimeridian"):
        validate_research_aoi(geometry)


@pytest.mark.parametrize(
    "position",
    [
        [True, 36],
        [10, False],
        [10**10000, 36],
        [10, 36, 5],
    ],
)
def test_rejects_boolean_unrepresentable_and_non_2d_coordinates(position):
    geometry = {"type": "Polygon", "coordinates": [[
        position, [11, 36], [11, 37], position,
    ]]}
    with pytest.raises(AOIValidationError):
        validate_research_aoi(geometry)


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "MultiPolygon", "coordinates": []},
        {"type": "Polygon", "coordinates": []},
        {"type": "Polygon", "coordinates": [[
            [10, 36], [11, 36], [11, 37], [10, 36],
        ]]},
    ],
)
def test_rejects_empty_or_malformed_polygon_collections(geometry):
    with pytest.raises(AOIValidationError):
        validate_research_aoi(geometry)
