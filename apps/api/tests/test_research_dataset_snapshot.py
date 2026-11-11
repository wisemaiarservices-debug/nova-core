from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

from apps.api.services.research_run_lineage import (
    build_research_run_lineage,
    canonical_json_sha256,
)
from apps.api.services.research_dataset_snapshot import ResearchDatasetSnapshot

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
        "aoi_sha256": canonical_json_sha256(AOI),
        "aoi_bbox": (10.0, 36.0, 11.0, 37.0),
    }
    payload.update(overrides)
    return payload


def test_snapshot_fingerprint_is_stable_and_bound_to_processed_window():
    lineage = build_research_run_lineage("experiment-water-001", AOI, _manifest())
    first = ResearchDatasetSnapshot.from_lineage(lineage)
    second = ResearchDatasetSnapshot.from_lineage(lineage)
    assert first.snapshot_sha256 == second.snapshot_sha256
    assert first.snapshot_id == second.snapshot_id
    assert first.dataset_id == "fao-wapor-v3"
    assert first.evidence_class == "satellite_derived"
    assert first.site_id is None


def test_snapshot_identity_changes_when_any_scientific_input_changes():
    first_lineage = build_research_run_lineage("experiment-water-001", AOI, _manifest())
    changed_lineage = build_research_run_lineage(
        "experiment-water-001", AOI, _manifest(processed_window_sha256="e" * 64)
    )
    assert (
        ResearchDatasetSnapshot.from_lineage(first_lineage).snapshot_sha256
        != ResearchDatasetSnapshot.from_lineage(changed_lineage).snapshot_sha256
    )


def test_snapshot_preserves_optional_full_source_object_hash():
    lineage = build_research_run_lineage(
        "experiment-water-001", AOI, _manifest(source_object_sha256="d" * 64)
    )
    snapshot = ResearchDatasetSnapshot.from_lineage(lineage)
    assert snapshot.source_object_sha256 == "d" * 64


def test_snapshot_rejects_customer_site_identity_and_invalid_hashes():
    lineage = build_research_run_lineage("experiment-water-001", AOI, _manifest())
    snapshot = ResearchDatasetSnapshot.from_lineage(lineage)
    with pytest.raises(ValidationError):
        ResearchDatasetSnapshot.model_validate({**snapshot.model_dump(), "site_id": "customer-site"})
    with pytest.raises(ValidationError):
        ResearchDatasetSnapshot.model_validate(
            {**snapshot.model_dump(), "processed_window_sha256": "not-a-hash"}
        )
