from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

from apps.api.services.experiment_registry import (
    ChronologicalSplit,
    ExperimentManifest,
    TimeWindow,
)
from apps.api.services.raster_provenance import RasterProcessingManifest
from apps.api.services.research_aoi import canonical_research_aoi_sha256
from apps.api.services.research_dataset_snapshot import ResearchDatasetSnapshot
from apps.api.services.research_run_lineage import (
    attach_lineage_to_experiment,
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


def _lineage(**manifest_overrides):
    return build_research_run_lineage(
        "experiment-water-001",
        AOI,
        _raster_manifest(**manifest_overrides),
    )


def _experiment(lineage, **overrides):
    snapshot = ResearchDatasetSnapshot.from_lineage(lineage)
    payload = {
        "experiment_id": "experiment-water-001",
        "domain": "water",
        "task": "research raster baseline",
        "target_variable": "soil_moisture",
        "target_unit": "m3/m3",
        "forecast_horizon": "dekadal",
        "dataset_id": "fao-wapor-v3",
        "dataset_version": "v3",
        "dataset_snapshot_sha256": snapshot.snapshot_sha256,
        "evidence_class": "satellite_derived",
        "geography": "WGS84 research AOI",
        "temporal_resolution": "dekadal",
        "feature_names": ("AETI",),
        "split": ChronologicalSplit(
            train=TimeWindow(
                start=datetime(2024, 1, 1, tzinfo=UTC),
                end=datetime(2024, 3, 31, tzinfo=UTC),
            ),
            validation=TimeWindow(
                start=datetime(2024, 4, 1, tzinfo=UTC),
                end=datetime(2024, 5, 31, tzinfo=UTC),
            ),
            test=TimeWindow(
                start=datetime(2024, 6, 1, tzinfo=UTC),
                end=datetime(2024, 7, 31, tzinfo=UTC),
            ),
        ),
        "code_commit": "c" * 40,
        "model_version": "baseline-v1",
    }
    payload.update(overrides)
    return ExperimentManifest.model_validate(payload)


def test_builds_stable_lineage_and_registry_reference():
    manifest = _raster_manifest()
    first = build_research_run_lineage("experiment-water-001", AOI, manifest)
    second = build_research_run_lineage("experiment-water-001", AOI, manifest)
    assert first.run_id == second.run_id
    assert first.aoi_sha256 == canonical_research_aoi_sha256(AOI)
    assert first.site_id is None
    assert first.evidence_class == "satellite_derived"
    assert first.raster_input_reference == {
        "manifest_id": manifest.manifest_id,
        "dataset_id": manifest.dataset_id,
        "processed_window_sha256": manifest.processed_window_sha256,
        "evidence_class": "satellite_derived",
    }


def test_run_identity_changes_when_provider_metadata_or_source_changes():
    baseline = _lineage()
    metadata_changed = _lineage(provider_metadata_sha256="d" * 64)
    source_changed = _lineage(source_object_sha256="e" * 64)
    assert baseline.run_id != metadata_changed.run_id
    assert baseline.run_id != source_changed.run_id


def test_source_object_hash_is_forwarded_only_when_present():
    lineage = _lineage(source_object_sha256="d" * 64)
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


def test_rejects_non_cog_or_incomplete_provider_manifest():
    with pytest.raises(ValueError, match="COG AOI"):
        build_research_run_lineage(
            "experiment-water-001",
            AOI,
            _raster_manifest(processing_method="nova-geotiff-strip-statistics-v1"),
        )
    with pytest.raises(ValueError, match="provider metadata"):
        build_research_run_lineage(
            "experiment-water-001",
            AOI,
            _raster_manifest(provider_metadata_sha256=None),
        )


def test_lineage_is_immutable_and_rejects_customer_site_identity():
    lineage = _lineage()
    with pytest.raises(ValidationError):
        lineage.site_id = "customer-site-1"
    with pytest.raises(ValidationError):
        ResearchRunLineage = type(lineage).model_validate({
            **lineage.model_dump(),
            "site_id": "customer-site-1",
        })


def test_attaches_to_real_experiment_manifest_only_when_snapshot_matches():
    lineage = _lineage()
    experiment = _experiment(lineage)
    updated = attach_lineage_to_experiment(experiment, lineage)
    assert isinstance(updated, ExperimentManifest)
    assert len(updated.raster_inputs) == 1
    assert updated.raster_inputs[0].manifest_id == lineage.raster_manifest.manifest_id
    assert updated.dataset_snapshot_sha256 == ResearchDatasetSnapshot.from_lineage(lineage).snapshot_sha256
    assert experiment.raster_inputs == ()


def test_experiment_handoff_rejects_wrong_experiment_dataset_or_snapshot():
    lineage = _lineage()
    with pytest.raises(ValueError, match="experiment_id"):
        attach_lineage_to_experiment(
            _experiment(lineage, experiment_id="experiment-water-002"),
            lineage,
        )
    with pytest.raises(ValueError, match="dataset_id"):
        attach_lineage_to_experiment(
            _experiment(lineage, dataset_id="another-dataset"),
            lineage,
        )
    with pytest.raises(ValueError, match="dataset_snapshot_sha256"):
        attach_lineage_to_experiment(
            _experiment(lineage, dataset_snapshot_sha256="f" * 64),
            lineage,
        )


def test_experiment_handoff_rejects_non_satellite_evidence_and_existing_raster_input():
    lineage = _lineage()
    with pytest.raises(ValueError, match="evidence_class"):
        attach_lineage_to_experiment(
            _experiment(lineage, evidence_class="field_observation"),
            lineage,
        )
    with pytest.raises(ValueError, match="one raster per dataset snapshot"):
        attach_lineage_to_experiment(
            _experiment(lineage, raster_inputs=(lineage.raster_input_reference,)),
            lineage,
        )


def test_canonical_json_hash_rejects_nan_and_is_key_order_stable():
    assert canonical_json_sha256({"b": 2, "a": 1}) == canonical_json_sha256({"a": 1, "b": 2})
    with pytest.raises(ValueError, match="JSON-compatible"):
        canonical_json_sha256({"bad": float("nan")})


def test_lineage_rejects_run_id_that_does_not_match_its_identity():
    lineage = _lineage()
    payload = lineage.model_dump(mode="python")
    payload["run_id"] = "nova-research-" + ("f" * 20)
    with pytest.raises(ValidationError, match="canonical research lineage identity"):
        type(lineage).model_validate(payload)
