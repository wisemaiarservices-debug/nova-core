from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

from apps.api.services.raster_provenance import RasterProcessingManifest


UTC = timezone.utc


def _manifest(**overrides):
    payload = {
        "manifest_id": "wapor.l2.aeti.2024-01",
        "provider": "FAO WaPOR",
        "dataset_id": "fao-wapor-v3",
        "dataset_version": "v3",
        "mapset_code": "L2-AETI-D",
        "raster_code": "AETI-D",
        "provider_period_start": date(2024, 1, 1),
        "provider_period_end": date(2024, 1, 10),
        "retrieved_at": datetime(2026, 11, 11, 12, tzinfo=UTC),
        "source_object_sha256": None,
        "processed_window_sha256": "a" * 64,
        "provider_metadata_sha256": "b" * 64,
        "processing_code_commit": "c" * 40,
        "processing_method": "nova-geotiff-strip-statistics-v1",
        "width": 2,
        "height": 2,
        "valid_pixel_count": 3,
        "nodata_pixel_count": 1,
        "raw_min": 1.0,
        "raw_max": 5.0,
        "raw_mean": 8 / 3,
        "units": None,
        "crs_identifier": "EPSG:4326",
        "geotransform": (10.0, 0.01, 0.0, 37.0, 0.0, -0.01),
        "aoi_sha256": "d" * 64,
        "aoi_bbox": (10.0, 36.0, 11.0, 37.0),
    }
    payload.update(overrides)
    return RasterProcessingManifest.model_validate(payload)


def test_manifest_captures_source_snapshot_processing_and_evidence():
    result = _manifest()
    assert result.provider == "FAO WaPOR"
    assert result.mapset_code == "L2-AETI-D"
    assert result.processed_window_sha256 == "a" * 64
    assert result.processing_code_commit == "c" * 40
    assert result.evidence_class == "satellite_derived"
    assert result.site_id is None
    assert result.units is None


def test_manifest_is_immutable_and_rejects_unknown_fields():
    result = _manifest()
    with pytest.raises(ValidationError):
        result.width = 3
    with pytest.raises(ValidationError):
        _manifest(customer_name="not-allowed")


def test_pixel_counts_must_match_raster_dimensions():
    with pytest.raises(ValidationError, match="pixel counts"):
        _manifest(valid_pixel_count=2, nodata_pixel_count=1)


def test_all_nodata_manifest_requires_null_raw_and_scaled_statistics():
    result = _manifest(
        valid_pixel_count=0,
        nodata_pixel_count=4,
        raw_min=None,
        raw_max=None,
        raw_mean=None,
    )
    assert result.raw_mean is None
    with pytest.raises(ValidationError, match="all-NoData"):
        _manifest(valid_pixel_count=0, nodata_pixel_count=4)


def test_valid_pixels_require_complete_ordered_raw_statistics():
    with pytest.raises(ValidationError, match="require min, max and mean"):
        _manifest(raw_mean=None)
    with pytest.raises(ValidationError, match="min <= mean <= max"):
        _manifest(raw_mean=99)


def test_scale_and_offset_must_be_paired_and_scaled_stats_complete():
    with pytest.raises(ValidationError, match="both be present"):
        _manifest(scale=0.1)
    with pytest.raises(ValidationError, match="complete scaled statistics"):
        _manifest(scale=0.1, offset=2.0)
    calibrated = _manifest(
        scale=0.1,
        offset=2.0,
        scaled_min=2.1,
        scaled_max=2.5,
        scaled_mean=2.2666666667,
        units="mm/day",
    )
    assert calibrated.scale == pytest.approx(0.1)


def test_period_and_retrieval_timestamp_are_validated():
    with pytest.raises(ValidationError, match="period end"):
        _manifest(provider_period_start=date(2024, 2, 1), provider_period_end=date(2024, 1, 1))
    with pytest.raises(ValidationError, match="timezone"):
        _manifest(retrieved_at=datetime(2026, 11, 11, 12))


def test_hashes_and_processing_commit_are_strict():
    with pytest.raises(ValidationError):
        _manifest(processed_window_sha256="not-a-hash")
    with pytest.raises(ValidationError):
        _manifest(processing_code_commit="short")


def test_aoi_bbox_must_be_ordered_and_wgs84_bounded():
    with pytest.raises(ValidationError, match="bounding box"):
        _manifest(aoi_bbox=(11.0, 37.0, 10.0, 36.0))
