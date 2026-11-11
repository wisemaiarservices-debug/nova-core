from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

from apps.api.services.experiment_registry import (
    ChronologicalSplit,
    ExperimentManifest,
    TimeWindow,
)
from apps.api.services.research_dataset_snapshot import ResearchDatasetSnapshot
from apps.api.services.research_experiment_pipeline import (
    evaluate_research_experiment,
    prepare_research_experiment,
)
from apps.api.services.research_run_lineage import (
    build_research_run_lineage,
    canonical_json_sha256,
)
from apps.api.services.raster_provenance import RasterProcessingManifest

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


def _lineage():
    return build_research_run_lineage(
        "neoagro.water.research.v1",
        AOI,
        _raster_manifest(),
    )


def _experiment(lineage=None, **overrides):
    lineage = lineage or _lineage()
    snapshot = ResearchDatasetSnapshot.from_lineage(lineage)
    start = datetime(2024, 1, 1, tzinfo=UTC)
    validation = datetime(2024, 1, 10, tzinfo=UTC)
    test = datetime(2024, 1, 20, tzinfo=UTC)
    end = datetime(2024, 1, 31, tzinfo=UTC)
    payload = {
        "experiment_id": "neoagro.water.research.v1",
        "domain": "water",
        "task": "Research comparison for satellite-derived water indicators",
        "target_variable": "AETI",
        "target_unit": "provider-native",
        "forecast_horizon": "retrospective",
        "dataset_id": "fao-wapor-v3",
        "dataset_version": "v3",
        "dataset_snapshot_sha256": snapshot.snapshot_sha256,
        "evidence_class": "satellite_derived",
        "geography": "Caller-supplied research AOI; not a registered customer site",
        "temporal_resolution": "dekadal",
        "feature_names": ["AETI"],
        "split": ChronologicalSplit(
            train=TimeWindow(start=start, end=validation),
            validation=TimeWindow(start=validation, end=test),
            test=TimeWindow(start=test, end=end),
        ),
        "code_commit": "d" * 40,
        "model_version": "offline-baseline-only-v0",
        "status": "research",
    }
    payload.update(overrides)
    return ExperimentManifest.model_validate(payload)


def test_pipeline_joins_snapshot_lineage_and_exact_processing_manifest():
    lineage = _lineage()
    bundle = prepare_research_experiment(
        _experiment(lineage),
        lineage,
        [lineage.raster_manifest],
    )
    assert bundle.run_id == lineage.run_id
    assert bundle.snapshot_id == ResearchDatasetSnapshot.from_lineage(lineage).snapshot_id
    assert bundle.experiment.raster_inputs[0].manifest_id == lineage.raster_manifest.manifest_id
    assert bundle.resolved_manifest_ids == (lineage.raster_manifest.manifest_id,)
    assert bundle.status == "research"
    assert bundle.lineage.site_id is None


def test_pipeline_rejects_wrong_experiment_or_missing_processing_manifest():
    lineage = _lineage()
    with pytest.raises(ValueError, match="experiment_id"):
        prepare_research_experiment(
            _experiment(lineage, experiment_id="different.experiment.v1"),
            lineage,
            [lineage.raster_manifest],
        )
    with pytest.raises(ValueError, match="at least one"):
        prepare_research_experiment(_experiment(lineage), lineage, [])


def test_pipeline_rejects_processing_manifest_checksum_mismatch():
    lineage = _lineage()
    changed = _raster_manifest(processed_window_sha256="e" * 64)
    with pytest.raises(ValueError, match="processed-window checksum"):
        prepare_research_experiment(_experiment(lineage), lineage, [changed])


def test_pipeline_rejects_snapshot_mismatch_before_bundle_creation():
    lineage = _lineage()
    experiment = _experiment(lineage, dataset_snapshot_sha256="0" * 64)
    with pytest.raises(ValueError, match="dataset_snapshot_sha256"):
        prepare_research_experiment(experiment, lineage, [lineage.raster_manifest])


def test_evaluation_returns_new_bundle_and_keeps_original_research_bundle_immutable():
    lineage = _lineage()
    bundle = prepare_research_experiment(_experiment(lineage), lineage, [lineage.raster_manifest])
    evaluated = evaluate_research_experiment(
        bundle,
        [10, 12, 14],
        [11, 11, 15],
        [9, 13, 13],
        test_period_start=datetime(2024, 1, 20, tzinfo=UTC),
        test_period_end=datetime(2024, 1, 31, tzinfo=UTC),
    )
    assert bundle.status == "research"
    assert bundle.experiment.status == "research"
    assert evaluated.status == "evaluated"
    assert evaluated.experiment.status == "evaluated"
    assert evaluated.evaluation_metrics.sample_count == 3
    assert evaluated.evaluation_metrics.rmse_skill_score == pytest.approx(0.0)


def test_evaluation_rejects_metrics_outside_declared_holdout_period():
    lineage = _lineage()
    bundle = prepare_research_experiment(_experiment(lineage), lineage, [lineage.raster_manifest])
    with pytest.raises(ValidationError, match="before the declared test split"):
        evaluate_research_experiment(
            bundle,
            [10, 12],
            [11, 11],
            [9, 13],
            test_period_start=datetime(2024, 1, 19, tzinfo=UTC),
            test_period_end=datetime(2024, 1, 31, tzinfo=UTC),
        )


def test_evaluation_cannot_be_repeated_on_an_evaluated_bundle():
    lineage = _lineage()
    bundle = prepare_research_experiment(_experiment(lineage), lineage, [lineage.raster_manifest])
    evaluated = evaluate_research_experiment(
        bundle,
        [10, 12],
        [11, 11],
        [9, 13],
        test_period_start=datetime(2024, 1, 20, tzinfo=UTC),
        test_period_end=datetime(2024, 1, 31, tzinfo=UTC),
    )
    with pytest.raises(ValueError, match="unevaluated"):
        evaluate_research_experiment(
            evaluated,
            [10, 12],
            [11, 11],
            [9, 13],
            test_period_start=datetime(2024, 1, 20, tzinfo=UTC),
            test_period_end=datetime(2024, 1, 31, tzinfo=UTC),
        )
