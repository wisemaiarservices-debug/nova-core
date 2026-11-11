from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

from apps.api.services.raster_provenance import RasterProcessingManifest
from apps.api.services.research_run_lineage import (
    build_research_run_lineage,
    canonical_json_sha256,
)

UTC = timezone.utc
AOI = {
    "type": "Polygon",
    "coordinates": [[[10.0, 36.0], [11.0, 36.0], [11.0, 37.0], [10.0, 37.0], [10.0, 36.0]]],
}


def _raster_manifest(**overrides):
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
    return RasterProcessingManifest.model_validate(payload)


def test_builds_stable_lineage_and_experiment_registry_reference():
    manifest = _raster_manifest()
    first = build_research_run_lineage("experiment-water-001", AOI, manifest)
    second = build_research_run_lineage("experiment-water-001", AOI, manifest)
    assert first.run_id == second.run_id
    assert first.aoi_sha256 == manifest.aoi_sha256
    assert first.site_id is None
    assert first.evidence_class == "satellite_derived"
    assert first.raster_input_reference == {
        "manifest_id": manifest.manifest_id,
        "dataset_id": manifest.dataset_id,
        "processed_window_sha256": manifest.processed_window_sha256,
        "evidence_class": "satellite_derived",
    }


def test_source_object_hash_is_forwarded_only_when_present():
    manifest = _raster_manifest(source_object_sha256="d" * 64)
    lineage = build_research_run_lineage("experiment-water-001", AOI, manifest)
    assert lineage.raster_input_reference["source_object_sha256"] == "d" * 64


def test_rejects_aoi_geometry_changed_after_raster_processing():
    changed = {
        "type": "Polygon",
        "coordinates": [[[10.0, 36.0], [11.1, 36.0], [11.0, 37.0], [10.0, 37.0], [10.0, 36.0]]],
    }
    with pytest.raises(ValueError, match="exact AOI"):
        build_research_run_lineage("experiment-water-001", changed, _raster_manifest())


def test_rejects_manifest_bbox_or_aoi_hash_mismatch():
    with pytest.raises(ValueError, match="bounds"):
        build_research_run_lineage(
            "experiment-water-001",
            AOI,
            _raster_manifest(aoi_bbox=(10.0, 36.0, 10.5, 37.0)),
        )


def test_lineage_is_immutable_and_rejects_customer_site_identity():
    lineage = build_research_run_lineage("experiment-water-001", AOI, _raster_manifest())
    with pytest.raises(ValidationError):
        lineage.site_id = "customer-site-1"
    with pytest.raises(ValidationError):
        lineage.model_copy(update={"site_id": "customer-site-1"}).model_validate(
            {"**": "not-used"}
        )
