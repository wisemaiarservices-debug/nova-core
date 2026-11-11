from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from apps.api.services.experiment_registry import (
    ChronologicalSplit,
    ExperimentManifest,
    TimeWindow,
    evaluate_regression,
)


UTC = timezone.utc


def _window(start_day, end_day):
    return TimeWindow(
        start=datetime(2024, 1, start_day, tzinfo=UTC),
        end=datetime(2024, 1, end_day, tzinfo=UTC),
    )


def _split():
    return ChronologicalSplit(
        train=_window(1, 10),
        validation=_window(10, 20),
        test=_window(20, 31),
    )


def _manifest(**overrides):
    payload = {
        "experiment_id": "neoagro.et0.baseline.v1",
        "domain": "agriculture",
        "task": "Daily reference evapotranspiration baseline comparison",
        "target_variable": "ET0",
        "target_unit": "mm/day",
        "forecast_horizon": "1 day",
        "dataset_id": "nasa-power-daily",
        "dataset_version": "provider archive response",
        "dataset_snapshot_sha256": "a" * 64,
        "evidence_class": "gridded_model_product",
        "geography": "Explicit research area; not a registered customer site",
        "temporal_resolution": "daily",
        "feature_names": ["T2M", "RH2M", "WS10M"],
        "split": _split().model_dump(),
        "code_commit": "b" * 40,
        "model_version": "deterministic-reference-baseline-v0",
        "status": "research",
    }
    payload.update(overrides)
    return ExperimentManifest.model_validate(payload)


def test_manifest_is_immutable_and_captures_reproducibility_fields():
    manifest = _manifest()
    assert manifest.status == "research"
    assert manifest.dataset_snapshot_sha256 == "a" * 64
    assert manifest.evidence_class == "gridded_model_product"
    with pytest.raises(ValidationError):
        manifest.status = "evaluated"


def test_split_requires_timezone_and_strict_chronology():
    with pytest.raises(ValidationError, match="timezone"):
        TimeWindow(start=datetime(2024, 1, 1), end=datetime(2024, 1, 2))
    with pytest.raises(ValidationError, match="overlap"):
        ChronologicalSplit(
            train=_window(1, 12),
            validation=_window(10, 20),
            test=_window(20, 31),
        )


def test_manifest_rejects_invalid_hashes_and_duplicate_features():
    with pytest.raises(ValidationError):
        _manifest(dataset_snapshot_sha256="not-a-sha256")
    with pytest.raises(ValidationError, match="unique"):
        _manifest(feature_names=["T2M", "T2M"])


def test_evaluated_manifest_requires_holdout_metrics():
    with pytest.raises(ValidationError, match="holdout metrics"):
        _manifest(status="evaluated")


def test_evaluation_computes_metrics_against_explicit_baseline():
    metrics = evaluate_regression(
        [10, 12, 14],
        [11, 11, 15],
        [9, 13, 13],
        test_period_start=datetime(2024, 1, 20, tzinfo=UTC),
        test_period_end=datetime(2024, 1, 31, tzinfo=UTC),
    )
    assert metrics.sample_count == 3
    assert metrics.mae == pytest.approx(1.0)
    assert metrics.rmse == pytest.approx(1.0)
    assert metrics.mean_error == pytest.approx(1 / 3)
    assert metrics.baseline_mae == pytest.approx(1.0)
    assert metrics.baseline_rmse == pytest.approx(1.0)
    assert metrics.rmse_skill_score == pytest.approx(0.0)


def test_evaluation_reports_negative_skill_when_model_loses_to_baseline():
    metrics = evaluate_regression(
        [1, 2, 3],
        [4, 5, 6],
        [2, 2, 2],
        test_period_start=datetime(2024, 1, 20, tzinfo=UTC),
        test_period_end=datetime(2024, 1, 31, tzinfo=UTC),
    )
    assert metrics.rmse_skill_score is not None
    assert metrics.rmse_skill_score < 0


def test_zero_error_baseline_has_undefined_skill_not_division_error():
    metrics = evaluate_regression(
        [1, 2],
        [1, 2],
        [1, 2],
        test_period_start=datetime(2024, 1, 20, tzinfo=UTC),
        test_period_end=datetime(2024, 1, 31, tzinfo=UTC),
    )
    assert metrics.baseline_rmse == 0
    assert metrics.rmse_skill_score is None


@pytest.mark.parametrize(
    "actual,predicted,baseline",
    [
        ([1, float("nan")], [1, 2], [1, 2]),
        ([1, 2], [1, float("inf")], [1, 2]),
        ([1, 2], [1, 2], [1, float("-inf")]),
        ([1, 2], [1], [1, 2]),
        ([1], [1], [1]),
        ([True, 2], [1, 2], [1, 2]),
    ],
)
def test_evaluation_rejects_nonfinite_unpaired_boolean_or_too_small_inputs(actual, predicted, baseline):
    with pytest.raises(ValueError):
        evaluate_regression(
            actual,
            predicted,
            baseline,
            test_period_start=datetime(2024, 1, 20, tzinfo=UTC),
            test_period_end=datetime(2024, 1, 31, tzinfo=UTC),
        )


def test_evaluated_manifest_accepts_metrics_inside_declared_test_window():
    metrics = evaluate_regression(
        [1, 2],
        [1, 2],
        [2, 3],
        test_period_start=datetime(2024, 1, 20, tzinfo=UTC),
        test_period_end=datetime(2024, 1, 31, tzinfo=UTC),
    )
    manifest = _manifest(status="evaluated", metrics=metrics.model_dump())
    assert manifest.status == "evaluated"
    assert manifest.metrics.sample_count == 2


def test_evaluated_manifest_metrics_must_fit_inside_test_window():
    metrics = evaluate_regression(
        [1, 2],
        [1, 2],
        [2, 3],
        test_period_start=datetime(2024, 1, 19, tzinfo=UTC),
        test_period_end=datetime(2024, 1, 31, tzinfo=UTC),
    )
    with pytest.raises(ValidationError, match="before the declared test split"):
        _manifest(status="evaluated", metrics=metrics.model_dump())


def test_metric_overflow_is_rejected_as_invalid_scientific_output():
    with pytest.raises(ValueError, match="numeric range"):
        evaluate_regression(
            [-1e308, 1e308],
            [1e308, -1e308],
            [0, 0],
            test_period_start=datetime(2024, 1, 20, tzinfo=UTC),
            test_period_end=datetime(2024, 1, 31, tzinfo=UTC),
        )
