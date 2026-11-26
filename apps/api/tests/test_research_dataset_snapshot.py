from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

from apps.api.services.research_dataset_snapshot import ResearchDatasetSnapshot
from apps.api.services.research_run_lineage import build_research_run_lineage
from apps.api.services.research_aoi import canonical_research_aoi_sha256
from apps.api.services.raster_provenance import RasterProcessingManifest

UTC = timezone.utc
AOI = {
    "type": "Polygon",
    "coordinates": [[[10.0, 36.0], [11.0, 36.0], [11.0, 37.0], [10.0, 37.0], [10.0, 36.0]]],
}


def _manifest(**overrides):
    payload = {
        "manifest_id": "wapor.l2.aeti.2024-01",
        "provider": "FAO WaPOR",
        "dataset_id": "fao-wapor-v3",
        "dataset_version": "v3",
        "mapset_code": "L2-AETI-D",
        "raster_code": "WAPOR-3.L2-AETI-D.2024-01-D1",
        "provider_period_start": date(2024, 1, 1),
        "provider_period_end": date(2024, 1, 10),
        "retrieved_at": datetime(2026, 11, 11, 12, tzinfo=UTC),
        "processed_window_sha256": "a" * 64,
        "provider_metadata_sha256": "b" * 64,
        "processing_code_commit": "c" * 40,
        "processing_method": "nova-wapor-cog-aoi-v1",
        "source_dtype": "float32",
        "source_nodata": "-9999.0",
        "width": 2,
        "height": 2,
        "source_width": 100,
        "source_height": 100,
        "valid_pixel_count": 3,
        "nodata_pixel_count": 0,
        "outside_aoi_pixel_count": 1,
        "raw_min": 1.0,
        "raw_max": 5.0,
        "raw_mean": 3.0,
        "crs_identifier": "EPSG:4326",
        "geotransform": (10.0, 0.01, 0.0, 37.0, 0.0, -0.01),
        "units": "mm/day",
        "aoi_sha256": canonical_research_aoi_sha256(AOI),
        "aoi_bbox": (10.0, 36.0, 11.0, 37.0),
    }
    payload.update(overrides)
    return RasterProcessingManifest.model_validate(payload)


def _snapshot(**manifest_overrides):
    lineage = build_research_run_lineage(
        "experiment-water-001",
        AOI,
        _manifest(**manifest_overrides),
    )
    return ResearchDatasetSnapshot.from_lineage(lineage)


def test_snapshot_fingerprint_is_stable_and_binds_complete_scientific_metadata():
    first = _snapshot()
    second = _snapshot(retrieved_at=datetime(2026, 11, 12, 12, tzinfo=UTC))
    assert first.snapshot_sha256 == second.snapshot_sha256
    assert first.snapshot_id == second.snapshot_id
    assert first.dataset_id == "fao-wapor-v3"
    assert first.evidence_class == "satellite_derived"
    assert first.site_id is None
    assert first.source_dtype == "float32"
    assert first.source_nodata == "-9999.0"
    assert not hasattr(first, "retrieved_at")


@pytest.mark.parametrize("field,value", [
    ("processed_window_sha256", "e" * 64),
    ("provider_metadata_sha256", "f" * 64),
    ("source_nodata", "-8888"),
    ("source_dtype", "int16"),
    ("crs_identifier", "OGC:CRS84"),
    ("units", "m3/m3"),
    ("source_width", 101),
])
def test_snapshot_identity_changes_when_scientific_input_changes(field, value):
    baseline = _snapshot()
    changed = _snapshot(**{field: value})
    assert baseline.snapshot_sha256 != changed.snapshot_sha256


def test_snapshot_preserves_optional_full_source_object_hash():
    snapshot = _snapshot(source_object_sha256="d" * 64)
    assert snapshot.source_object_sha256 == "d" * 64


def test_snapshot_rejects_invalid_pixel_accounting_and_period():
    lineage = build_research_run_lineage(
        "experiment-water-001",
        AOI,
        _manifest(),
    )
    snapshot = ResearchDatasetSnapshot.from_lineage(lineage)
    payload = snapshot.model_dump(mode="python")
    payload["valid_pixel_count"] = 4
    with pytest.raises(ValidationError, match="pixel counts"):
        ResearchDatasetSnapshot.model_validate(payload)
    payload = snapshot.model_dump(mode="python")
    payload["period_end"] = date(2023, 12, 31)
    with pytest.raises(ValidationError, match="period end"):
        ResearchDatasetSnapshot.model_validate(payload)


def test_snapshot_rejects_unpaired_source_dimensions_and_user_defined_crs():
    lineage = build_research_run_lineage("experiment-water-001", AOI, _manifest())
    snapshot = ResearchDatasetSnapshot.from_lineage(lineage)
    payload = snapshot.model_dump(mode="python")
    payload["source_height"] = None
    with pytest.raises(ValidationError, match="source dimensions"):
        ResearchDatasetSnapshot.model_validate(payload)
    payload = snapshot.model_dump(mode="python")
    payload["crs_identifier"] = "EPSG:32767"
    with pytest.raises(ValidationError, match="32767"):
        ResearchDatasetSnapshot.model_validate(payload)


def test_snapshot_rejects_customer_site_identity_and_invalid_hashes():
    lineage = build_research_run_lineage("experiment-water-001", AOI, _manifest())
    snapshot = ResearchDatasetSnapshot.from_lineage(lineage)
    with pytest.raises(ValidationError):
        ResearchDatasetSnapshot.model_validate({**snapshot.model_dump(), "site_id": "customer-site"})
    with pytest.raises(ValidationError):
        ResearchDatasetSnapshot.model_validate(
            {**snapshot.model_dump(), "processed_window_sha256": "not-a-hash"}
        )
