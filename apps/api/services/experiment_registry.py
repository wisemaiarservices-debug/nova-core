"""Reproducible experiment manifests and bounded offline regression evaluation.

This module validates metadata and computes metrics from caller-supplied arrays.
It does not train models, load datasets, persist records, or certify results.
"""
from __future__ import annotations

import math
from datetime import datetime
from itertools import islice
from typing import Any, Literal, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_EVALUATION_SAMPLES = 1_000_000
MAX_RASTER_PROCESSING_MANIFESTS = 200

EvidenceClass = Literal[
    "field_observation",
    "provider_observation",
    "satellite_derived",
    "reanalysis",
    "gridded_model_product",
    "model_estimate",
    "scenario_simulation",
    "synthetic_test_fixture",
]


def _require_aware(value: datetime, label: str) -> None:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{label} timestamps must include a valid timezone offset")


class TimeWindow(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    start: datetime
    end: datetime

    @model_validator(mode="after")
    def validate_window(self) -> "TimeWindow":
        _require_aware(self.start, "split")
        _require_aware(self.end, "split")
        if self.end <= self.start:
            raise ValueError("split window end must be after start")
        return self


class ChronologicalSplit(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    train: TimeWindow
    validation: TimeWindow
    test: TimeWindow

    @model_validator(mode="after")
    def validate_chronology(self) -> "ChronologicalSplit":
        if self.train.end > self.validation.start:
            raise ValueError("training and validation windows overlap or are out of order")
        if self.validation.end > self.test.start:
            raise ValueError("validation and test windows overlap or are out of order")
        return self


class EvaluationMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    sample_count: int = Field(ge=2)
    mae: float = Field(ge=0, allow_inf_nan=False)
    rmse: float = Field(ge=0, allow_inf_nan=False)
    mean_error: float = Field(allow_inf_nan=False)
    baseline_mae: float = Field(ge=0, allow_inf_nan=False)
    baseline_rmse: float = Field(ge=0, allow_inf_nan=False)
    rmse_skill_score: float | None = Field(default=None, allow_inf_nan=False)
    test_period_start: datetime
    test_period_end: datetime

    @model_validator(mode="after")
    def validate_test_period(self) -> "EvaluationMetrics":
        _require_aware(self.test_period_start, "test period")
        _require_aware(self.test_period_end, "test period")
        if self.test_period_end <= self.test_period_start:
            raise ValueError("test period end must be after start")
        return self


class RasterInputReference(BaseModel):
    """Checksum-bound reference to an immutable satellite raster processing record."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    manifest_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{2,79}$")
    dataset_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,79}$")
    processed_window_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_object_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    evidence_class: Literal["satellite_derived"] = "satellite_derived"


class ExperimentManifest(BaseModel):
    """Immutable description of an experiment; status is not deployment approval."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    experiment_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{2,79}$")
    domain: Literal["agriculture", "water", "solar", "energy", "climate", "infrastructure"]
    task: str = Field(min_length=3, max_length=160)
    target_variable: str = Field(min_length=1, max_length=100)
    target_unit: str = Field(min_length=1, max_length=48)
    forecast_horizon: str = Field(min_length=1, max_length=80)
    dataset_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,79}$")
    dataset_version: str = Field(min_length=1, max_length=160)
    dataset_snapshot_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    evidence_class: EvidenceClass
    geography: str = Field(min_length=2, max_length=180)
    temporal_resolution: str = Field(min_length=1, max_length=80)
    feature_names: tuple[str, ...] = Field(min_length=1, max_length=200)
    split: ChronologicalSplit
    code_commit: str = Field(pattern=r"^[a-f0-9]{40}$")
    model_version: str = Field(min_length=1, max_length=120)
    random_seed: int | None = Field(default=None, ge=0, le=2**32 - 1)
    model_artifact_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    status: Literal["research", "evaluated"] = "research"
    metrics: EvaluationMetrics | None = None
    raster_inputs: tuple[RasterInputReference, ...] = Field(default_factory=tuple, max_length=200)

    @model_validator(mode="after")
    def validate_release_state(self) -> "ExperimentManifest":
        if len(set(self.feature_names)) != len(self.feature_names):
            raise ValueError("feature_names must be unique")
        if any(not name.strip() or len(name) > 100 for name in self.feature_names):
            raise ValueError("feature names must be non-empty and at most 100 characters")
        if self.status == "evaluated" and self.metrics is None:
            raise ValueError("evaluated experiments require holdout metrics")
        raster_ids = [item.manifest_id for item in self.raster_inputs]
        if len(set(raster_ids)) != len(raster_ids):
            raise ValueError("raster input manifest IDs must be unique")
        if self.raster_inputs:
            if self.evidence_class != "satellite_derived":
                raise ValueError("experiments with raster inputs must retain satellite_derived evidence")
            if any(item.dataset_id != self.dataset_id for item in self.raster_inputs):
                raise ValueError("raster input dataset IDs must match the experiment dataset_id")
        if self.metrics is not None:
            if self.metrics.test_period_start < self.split.test.start:
                raise ValueError("metrics test period begins before the declared test split")
            if self.metrics.test_period_end > self.split.test.end:
                raise ValueError("metrics test period ends after the declared test split")
        return self


def _validated_values(values: Sequence[float], name: str) -> list[float]:
    if isinstance(values, (str, bytes)):
        raise ValueError(f"{name} must be a numeric sequence")
    try:
        raw_values = list(islice(iter(values), MAX_EVALUATION_SAMPLES + 1))
    except TypeError as exc:
        raise ValueError(f"{name} must be a numeric sequence") from exc
    if len(raw_values) > MAX_EVALUATION_SAMPLES:
        raise ValueError(f"{name} exceeds the {MAX_EVALUATION_SAMPLES}-sample evaluation limit")
    if any(isinstance(value, (bool, str, bytes)) for value in raw_values):
        raise ValueError(f"{name} must contain numeric values, not booleans or strings")
    try:
        result = [float(value) for value in raw_values]
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must contain only numeric values") from exc
    if not result:
        raise ValueError(f"{name} must contain at least one value")
    if not all(math.isfinite(value) for value in result):
        raise ValueError(f"{name} must contain only finite values")
    return result


def _regression_summary(
    actual: list[float], predicted: list[float]
) -> tuple[float, float, float]:
    errors = [prediction - observed for observed, prediction in zip(actual, predicted)]
    if not all(math.isfinite(error) for error in errors):
        raise ValueError("regression metrics exceed supported numeric range")
    try:
        mae = math.fsum(abs(error) for error in errors) / len(errors)
        rmse = math.hypot(*errors) / math.sqrt(len(errors))
        mean_error = math.fsum(errors) / len(errors)
    except (OverflowError, ValueError) as exc:
        raise ValueError("regression metrics exceed supported numeric range") from exc
    if not all(math.isfinite(value) for value in (mae, rmse, mean_error)):
        raise ValueError("regression metrics exceed supported numeric range")
    return mae, rmse, mean_error


def evaluate_regression(
    actuals: Sequence[float],
    predictions: Sequence[float],
    baseline_predictions: Sequence[float],
    *,
    test_period_start: datetime,
    test_period_end: datetime,
) -> EvaluationMetrics:
    """Compute paired holdout metrics against an explicit baseline.

    The caller must prove that inputs are genuine held-out records, that baseline
    selection avoided test leakage, and that all arrays use matching units.
    """
    actual = _validated_values(actuals, "actuals")
    predicted = _validated_values(predictions, "predictions")
    baseline = _validated_values(baseline_predictions, "baseline_predictions")
    if not (len(actual) == len(predicted) == len(baseline)):
        raise ValueError("actuals, predictions, and baseline_predictions must have equal lengths")
    if len(actual) < 2:
        raise ValueError("at least two paired holdout samples are required")
    mae, rmse, mean_error = _regression_summary(actual, predicted)
    baseline_mae, baseline_rmse, _ = _regression_summary(actual, baseline)
    skill = None if baseline_rmse == 0 else 1.0 - (rmse / baseline_rmse)
    if skill is not None and not math.isfinite(skill):
        raise ValueError("RMSE skill score exceeds supported numeric range")
    return EvaluationMetrics(
        sample_count=len(actual),
        mae=mae,
        rmse=rmse,
        mean_error=mean_error,
        baseline_mae=baseline_mae,
        baseline_rmse=baseline_rmse,
        rmse_skill_score=skill,
        test_period_start=test_period_start,
        test_period_end=test_period_end,
    )


def resolve_raster_input_manifests(
    experiment: ExperimentManifest,
    processing_manifests: Sequence[Mapping[str, Any]],
) -> tuple[Mapping[str, Any], ...]:
    """Resolve raster references against supplied immutable processing manifests.

    This is an offline consistency check only. The caller must load manifests
    from an approved source and verify external storage integrity separately.
    """
    if not experiment.raster_inputs:
        return ()
    if isinstance(processing_manifests, (str, bytes)) or not isinstance(
        processing_manifests, Sequence
    ):
        raise ValueError("processing_manifests must be a bounded sequence of mappings")
    if len(processing_manifests) > MAX_RASTER_PROCESSING_MANIFESTS:
        raise ValueError("processing_manifests exceeds the 200-manifest resolution limit")

    by_id: dict[str, Mapping[str, Any]] = {}
    for manifest in processing_manifests:
        if not isinstance(manifest, Mapping):
            raise ValueError("processing manifests must be mappings produced from validated manifest records")
        manifest_id = manifest.get("manifest_id")
        if not isinstance(manifest_id, str) or not manifest_id:
            raise ValueError("processing manifest is missing a stable manifest_id")
        if manifest_id in by_id:
            raise ValueError("processing manifest IDs must be unique")
        by_id[manifest_id] = dict(manifest)

    resolved: list[Mapping[str, Any]] = []
    for reference in experiment.raster_inputs:
        manifest = by_id.get(reference.manifest_id)
        if manifest is None:
            raise ValueError(f"raster processing manifest {reference.manifest_id} was not supplied")
        if manifest.get("dataset_id") != reference.dataset_id:
            raise ValueError("raster processing manifest dataset_id does not match the experiment reference")
        if manifest.get("dataset_version") != experiment.dataset_version:
            raise ValueError("raster processing manifest dataset_version does not match the experiment")
        if manifest.get("processed_window_sha256") != reference.processed_window_sha256:
            raise ValueError("raster processing manifest processed-window checksum does not match the experiment reference")
        if manifest.get("source_object_sha256") != reference.source_object_sha256:
            raise ValueError("raster processing manifest source-object checksum does not match the experiment reference")
        if manifest.get("evidence_class") != "satellite_derived":
            raise ValueError("raster processing manifest must retain satellite_derived evidence")
        if "site_id" not in manifest or manifest.get("site_id") is not None:
            raise ValueError("research raster processing manifests must explicitly declare site_id as null")
        resolved.append(manifest)
    return tuple(resolved)
