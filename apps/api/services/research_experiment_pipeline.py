"""Offline pipeline joining research snapshots, raster lineage and holdout evaluation.

This is a pure validation/evaluation layer. It does not fetch data, train models,
persist experiments, certify scientific validity, or approve deployment.
"""
from __future__ import annotations

from datetime import datetime
from typing import Sequence

from pydantic import BaseModel, ConfigDict, Field

from apps.api.services.experiment_registry import (
    EvaluationMetrics,
    ExperimentManifest,
    evaluate_regression,
    resolve_raster_input_manifests,
)
from apps.api.services.raster_provenance import RasterProcessingManifest
from apps.api.services.research_dataset_snapshot import ResearchDatasetSnapshot
from apps.api.services.research_run_lineage import (
    ResearchRunLineage,
    attach_lineage_to_experiment,
)


class ResearchExperimentBundle(BaseModel):
    """Immutable, reproducible bundle for one research-only experiment input."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    experiment: ExperimentManifest
    lineage: ResearchRunLineage
    dataset_snapshot: ResearchDatasetSnapshot
    resolved_manifest_ids: tuple[str, ...] = Field(min_length=1)
    evaluation_metrics: EvaluationMetrics | None = None

    @property
    def run_id(self) -> str:
        return self.lineage.run_id

    @property
    def snapshot_id(self) -> str:
        return self.dataset_snapshot.snapshot_id

    @property
    def status(self) -> str:
        return "evaluated" if self.evaluation_metrics is not None else "research"


def prepare_research_experiment(
    experiment: ExperimentManifest,
    lineage: ResearchRunLineage,
    processing_manifests: Sequence[RasterProcessingManifest],
) -> ResearchExperimentBundle:
    """Join exact experiment, AOI, snapshot and raster processing records.

    Every processing manifest must already have been loaded from an approved source
    and validated. This function checks consistency; it does not establish source
    authenticity or verify remote object bytes.
    """
    if experiment.experiment_id != lineage.experiment_id:
        raise ValueError("experiment_id does not match the research run lineage")
    if not processing_manifests:
        raise ValueError("at least one validated raster processing manifest is required")

    snapshot = ResearchDatasetSnapshot.from_lineage(lineage)
    attached = attach_lineage_to_experiment(experiment, lineage)
    if not isinstance(attached, ExperimentManifest):
        raise ValueError("lineage adapter did not return an ExperimentManifest")

    manifest_payloads = [item.model_dump(mode="json") for item in processing_manifests]
    resolved = resolve_raster_input_manifests(attached, manifest_payloads)
    resolved_ids = tuple(str(item["manifest_id"]) for item in resolved)
    expected_id = lineage.raster_manifest.manifest_id
    if resolved_ids.count(expected_id) != 1:
        raise ValueError("the exact lineage raster manifest must resolve exactly once")

    return ResearchExperimentBundle(
        experiment=attached,
        lineage=lineage,
        dataset_snapshot=snapshot,
        resolved_manifest_ids=resolved_ids,
    )


def evaluate_research_experiment(
    bundle: ResearchExperimentBundle,
    actuals: Sequence[float],
    predictions: Sequence[float],
    baseline_predictions: Sequence[float],
    *,
    test_period_start: datetime,
    test_period_end: datetime,
) -> ResearchExperimentBundle:
    """Evaluate caller-supplied holdout arrays and return a new immutable bundle.

    The caller must establish that arrays are genuinely held out, aligned in time,
    expressed in the declared target unit, and that the baseline was chosen without
    test leakage. Metrics alone do not establish model validity or deployment fitness.
    """
    if bundle.evaluation_metrics is not None or bundle.experiment.status != "research":
        raise ValueError("only an unevaluated research bundle can be evaluated")

    metrics = evaluate_regression(
        actuals,
        predictions,
        baseline_predictions,
        test_period_start=test_period_start,
        test_period_end=test_period_end,
    )
    evaluated_experiment = ExperimentManifest.model_validate(
        {
            **bundle.experiment.model_dump(mode="python"),
            "status": "evaluated",
            "metrics": metrics.model_dump(mode="python"),
        }
    )
    return bundle.model_copy(
        update={
            "experiment": evaluated_experiment,
            "evaluation_metrics": metrics,
        }
    )
