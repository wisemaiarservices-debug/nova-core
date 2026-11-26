"""Offline pipeline joining dataset snapshots, raster lineage and holdout evaluation.

This is a pure validation/evaluation layer. It does not fetch data, train models,
persist experiments, certify scientific validity, or approve deployment.
"""
from __future__ import annotations

from datetime import datetime
from typing import Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    canonical_json_sha256,
)


class ResearchExperimentBundle(BaseModel):
    """Immutable, single-raster research bundle with mutually consistent identities."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    experiment: ExperimentManifest
    lineage: ResearchRunLineage
    dataset_snapshot: ResearchDatasetSnapshot
    resolved_manifest_ids: tuple[str, ...] = Field(min_length=1, max_length=1)
    evaluation_metrics: EvaluationMetrics | None = None

    @model_validator(mode="after")
    def validate_bundle_consistency(self) -> "ResearchExperimentBundle":
        manifest = self.lineage.raster_manifest
        if self.experiment.experiment_id != self.lineage.experiment_id:
            raise ValueError("bundle experiment ID does not match its lineage")
        expected_snapshot = ResearchDatasetSnapshot.from_lineage(self.lineage)
        if self.dataset_snapshot.snapshot_sha256 != expected_snapshot.snapshot_sha256:
            raise ValueError("bundle dataset snapshot does not match its lineage")
        if self.experiment.dataset_snapshot_sha256 != self.dataset_snapshot.snapshot_sha256:
            raise ValueError("bundle experiment dataset snapshot hash does not match its snapshot")
        if self.experiment.dataset_id != manifest.dataset_id or self.experiment.dataset_version != manifest.dataset_version:
            raise ValueError("bundle experiment dataset identity does not match its raster manifest")
        if len(self.experiment.raster_inputs) != 1:
            raise ValueError("bundle must reference exactly one raster input")
        actual_reference = self.experiment.raster_inputs[0].model_dump(mode="python", exclude_none=True)
        if actual_reference != self.lineage.raster_input_reference:
            raise ValueError("bundle raster input reference does not match its lineage")
        if self.resolved_manifest_ids != (manifest.manifest_id,):
            raise ValueError("bundle must resolve exactly its lineage raster manifest")
        if self.evaluation_metrics is None:
            if self.experiment.status != "research" or self.experiment.metrics is not None:
                raise ValueError("unevaluated bundle must contain a research-status experiment without metrics")
        else:
            if self.experiment.status != "evaluated" or self.experiment.metrics != self.evaluation_metrics:
                raise ValueError("bundle evaluation metrics must match the evaluated experiment manifest")
        return self

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
    """Join one exact experiment, AOI, snapshot and validated processing manifest.

    The manifest must already have been loaded from an approved source. This function
    checks full model identity and reference consistency; it does not establish source
    authenticity or verify remote object bytes.
    """
    if not isinstance(experiment, ExperimentManifest):
        raise ValueError("experiment must be a validated ExperimentManifest")
    if not isinstance(lineage, ResearchRunLineage):
        raise ValueError("lineage must be a validated ResearchRunLineage")
    if experiment.experiment_id != lineage.experiment_id:
        raise ValueError("experiment_id does not match the research run lineage")
    if experiment.status != "research" or experiment.metrics is not None:
        raise ValueError("only an unevaluated research experiment can be prepared")
    if isinstance(processing_manifests, (str, bytes)) or not isinstance(processing_manifests, Sequence):
        raise ValueError("processing_manifests must be a sequence of validated raster manifests")
    if not processing_manifests:
        raise ValueError("at least one validated raster processing manifest is required")
    if len(processing_manifests) != 1:
        raise ValueError("the current research bundle supports exactly one raster processing manifest")
    if not isinstance(processing_manifests[0], RasterProcessingManifest):
        raise ValueError("processing_manifests must contain validated RasterProcessingManifest objects")

    snapshot = ResearchDatasetSnapshot.from_lineage(lineage)
    attached = attach_lineage_to_experiment(experiment, lineage)
    manifest_payload = processing_manifests[0].model_dump(mode="json")
    resolved = resolve_raster_input_manifests(attached, [manifest_payload])
    if len(resolved) != 1:
        raise ValueError("the lineage raster processing manifest must resolve exactly once")
    expected_payload = lineage.raster_manifest.model_dump(mode="json")
    if canonical_json_sha256(dict(resolved[0])) != canonical_json_sha256(expected_payload):
        raise ValueError("resolved processing manifest does not exactly match the lineage manifest")

    return ResearchExperimentBundle(
        experiment=attached,
        lineage=lineage,
        dataset_snapshot=snapshot,
        resolved_manifest_ids=(str(resolved[0]["manifest_id"]),),
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
    if not isinstance(bundle, ResearchExperimentBundle):
        raise ValueError("bundle must be a validated ResearchExperimentBundle")
    if bundle.status != "research" or bundle.experiment.status != "research":
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
    return ResearchExperimentBundle.model_validate(
        {
            "experiment": evaluated_experiment,
            "lineage": bundle.lineage,
            "dataset_snapshot": bundle.dataset_snapshot,
            "resolved_manifest_ids": bundle.resolved_manifest_ids,
            "evaluation_metrics": metrics,
        }
    )
