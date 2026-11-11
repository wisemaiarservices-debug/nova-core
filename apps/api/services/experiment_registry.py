"""Reproducible experiment manifests and offline regression evaluation.

This module validates experiment metadata and computes metrics from caller-supplied
arrays. It does not train models, load datasets, persist records, or certify results.
"""
from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Literal, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator


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


class TimeWindow(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    start: datetime
    end: datetime

    @model_validator(mode="after")
    def validate_window(self) -> "TimeWindow":
        if self.start.tzinfo is None or self.end.tzinfo is None:
            raise ValueError("split timestamps must include a timezone")
        if self.start.utcoffset() is None or self.end.utcoffset() is None:
            raise ValueError("split timestamps must include a valid UTC offset")
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

    sample_count: int = Field(ge=1)
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
        if self.test_period_start.tzinfo is None or self.test_period_end.tzinfo is None:
            raise ValueError("test period timestamps must include a timezone")
        if self.test_period_end <= self.test_period_start:
            raise ValueError("test period end must be after start")
        return self


class ExperimentManifest(BaseModel):
    """Immutable description of an experiment; status is not a deployment approval."""

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
    feature_names: list[str] = Field(min_length=1, max_length=200)
    split: ChronologicalSplit
    code_commit: str = Field(pattern=r"^[a-f0-9]{40}$")
    model_version: str = Field(min_length=1, max_length=120)
    random_seed: int | None = Field(default=None, ge=0, le=2**32 - 1)
    model_artifact_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    status: Literal["research", "evaluated"] = "research"
    metrics: EvaluationMetrics | None = None

    @model_validator(mode="after")
    def validate_release_state(self) -> "ExperimentManifest":
        if len(set(self.feature_names)) != len(self.feature_names):
            raise ValueError("feature_names must be unique")
        if any(not name.strip() or len(name) > 100 for name in self.feature_names):
            raise ValueError("feature names must be non-empty and at most 100 characters")
        if self.status == "evaluated" and self.metrics is None:
            raise ValueError("evaluated experiments require holdout metrics")
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
        result = [float(value) for value in values]
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must contain only numeric values") from exc
    if not result:
        raise ValueError(f"{name} must contain at least one value")
    if not all(math.isfinite(value) for value in result):
        raise ValueError(f"{name} must contain only finite values")
    return result


def _regression_summary(actual: list[float], predicted: list[float]) -> tuple[float, float, float]:
    errors = [prediction - observed for observed, prediction in zip(actual, predicted)]
    mae = sum(abs(error) for error in errors) / len(errors)
    mse = sum(error * error for error in errors) / len(errors)
    return mae, math.sqrt(mse), sum(errors) / len(errors)


def evaluate_regression(
    actuals: Sequence[float],
    predictions: Sequence[float],
    baseline_predictions: Sequence[float],
    *,
    test_period_start: datetime,
    test_period_end: datetime,
) -> EvaluationMetrics:
    """Compute paired holdout metrics against an explicit baseline.

    The caller is responsible for proving that inputs are genuine held-out records,
    that the baseline was selected without test leakage, and that units match.
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
