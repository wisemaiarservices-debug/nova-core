"""Offline lineage contract linking a caller AOI, WaPOR raster and experiment.

The contract is immutable and research-only. It does not fetch, persist, train,
register a site, or certify source authenticity or scientific accuracy.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from apps.api.services.experiment_registry import ExperimentManifest
from apps.api.services.raster_provenance import RasterProcessingManifest
from apps.api.services.research_aoi import (
    canonical_research_aoi_sha256,
    validate_research_aoi,
)


def canonical_json_sha256(payload: Any) -> str:
    """Hash finite JSON-compatible identity payloads using stable canonical JSON."""
    try:
        encoded = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError("lineage identity must be finite JSON-compatible data") from exc
    return hashlib.sha256(encoded).hexdigest()


class ResearchRunLineage(BaseModel):
    """Immutable, research-only link from explicit AOI to one WaPOR COG result."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: str = Field(pattern=r"^nova-research-[a-f0-9]{20}$")
    experiment_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{2,79}$")
    aoi_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    aoi_bbox: tuple[float, float, float, float]
    raster_manifest: RasterProcessingManifest
    evidence_class: Literal["satellite_derived"] = "satellite_derived"
    site_id: None = None

    @model_validator(mode="after")
    def validate_linkage(self) -> "ResearchRunLineage":
        manifest = self.raster_manifest
        if manifest.provider != "FAO WaPOR":
            raise ValueError("research run lineage requires the FAO WaPOR provider")
        if manifest.processing_method != "nova-wapor-cog-aoi-v1":
            raise ValueError("research run lineage requires a bounded WaPOR COG AOI processing manifest")
        if manifest.source_dtype is None:
            raise ValueError("WaPOR COG lineage requires source dtype metadata")
        if manifest.provider_metadata_sha256 is None:
            raise ValueError("WaPOR COG lineage requires a provider metadata fingerprint")
        if manifest.crs_identifier is None or manifest.geotransform is None:
            raise ValueError("WaPOR COG lineage requires explicit CRS and affine transform metadata")
        if manifest.evidence_class != "satellite_derived":
            raise ValueError("raster manifest evidence class must remain satellite_derived")
        if manifest.site_id is not None:
            raise ValueError("research raster manifests must not identify a customer site")
        if manifest.aoi_sha256 != self.aoi_sha256:
            raise ValueError("AOI checksum does not match the raster processing manifest")
        if manifest.aoi_bbox != self.aoi_bbox:
            raise ValueError("AOI bounds do not match the raster processing manifest")
        west, south, east, north = self.aoi_bbox
        if not all(math.isfinite(value) for value in self.aoi_bbox):
            raise ValueError("AOI bounds must be finite")
        if not (-180 <= west <= east <= 180 and -90 <= south <= north <= 90):
            raise ValueError("AOI bounds must be ordered WGS84 longitude/latitude")
        identity = {
            "experiment_id": self.experiment_id,
            "dataset_id": manifest.dataset_id,
            "dataset_version": manifest.dataset_version,
            "provider_period_start": manifest.provider_period_start.isoformat(),
            "provider_period_end": manifest.provider_period_end.isoformat(),
            "aoi_sha256": self.aoi_sha256,
            "manifest_id": manifest.manifest_id,
            "provider_metadata_sha256": manifest.provider_metadata_sha256,
            "processed_window_sha256": manifest.processed_window_sha256,
            "source_object_sha256": manifest.source_object_sha256,
            "processing_code_commit": manifest.processing_code_commit,
            "processing_method": manifest.processing_method,
        }
        expected_run_id = "nova-research-" + canonical_json_sha256(identity)[:20]
        if self.run_id != expected_run_id:
            raise ValueError("run_id does not match the canonical research lineage identity")
        return self

    @property
    def raster_input_reference(self) -> dict[str, str]:
        """Return the checksum-bound reference accepted by ExperimentManifest."""
        manifest = self.raster_manifest
        return {
            "manifest_id": manifest.manifest_id,
            "dataset_id": manifest.dataset_id,
            "processed_window_sha256": manifest.processed_window_sha256,
            "evidence_class": "satellite_derived",
            **(
                {"source_object_sha256": manifest.source_object_sha256}
                if manifest.source_object_sha256 is not None
                else {}
            ),
        }


def build_research_run_lineage(
    experiment_id: str,
    aoi_geometry: dict[str, Any],
    raster_manifest: RasterProcessingManifest | dict[str, Any],
) -> ResearchRunLineage:
    """Validate and join exact AOI geometry and one bounded WaPOR COG manifest."""
    summary = validate_research_aoi(aoi_geometry)
    aoi_hash = canonical_research_aoi_sha256(aoi_geometry)
    manifest = (
        raster_manifest
        if isinstance(raster_manifest, RasterProcessingManifest)
        else RasterProcessingManifest.model_validate(raster_manifest)
    )
    if manifest.aoi_sha256 != aoi_hash:
        raise ValueError("raster manifest was not produced for this exact AOI geometry")
    bbox = tuple(summary["bbox"])
    if manifest.aoi_bbox != bbox:
        raise ValueError("raster manifest AOI bounds do not match the supplied geometry")
    identity = {
        "experiment_id": experiment_id,
        "dataset_id": manifest.dataset_id,
        "dataset_version": manifest.dataset_version,
        "provider_period_start": manifest.provider_period_start.isoformat(),
        "provider_period_end": manifest.provider_period_end.isoformat(),
        "aoi_sha256": aoi_hash,
        "manifest_id": manifest.manifest_id,
        "provider_metadata_sha256": manifest.provider_metadata_sha256,
        "processed_window_sha256": manifest.processed_window_sha256,
        "source_object_sha256": manifest.source_object_sha256,
        "processing_code_commit": manifest.processing_code_commit,
        "processing_method": manifest.processing_method,
    }
    run_id = "nova-research-" + canonical_json_sha256(identity)[:20]
    return ResearchRunLineage(
        run_id=run_id,
        experiment_id=experiment_id,
        aoi_sha256=aoi_hash,
        aoi_bbox=bbox,
        raster_manifest=manifest,
    )


def attach_lineage_to_experiment(
    experiment: ExperimentManifest,
    lineage: ResearchRunLineage,
) -> ExperimentManifest:
    """Return a revalidated experiment copy with one snapshot-matched raster input."""
    from apps.api.services.research_dataset_snapshot import ResearchDatasetSnapshot

    if not isinstance(experiment, ExperimentManifest):
        raise ValueError("experiment must be a validated NOVA ExperimentManifest")
    if experiment.experiment_id != lineage.experiment_id:
        raise ValueError("experiment_id does not match the research run lineage")
    manifest = lineage.raster_manifest
    if experiment.dataset_id != manifest.dataset_id:
        raise ValueError("experiment dataset_id does not match the research raster")
    if experiment.dataset_version != manifest.dataset_version:
        raise ValueError("experiment dataset_version does not match the research raster")
    if experiment.evidence_class != "satellite_derived":
        raise ValueError("experiment evidence_class must be satellite_derived")
    expected_snapshot = ResearchDatasetSnapshot.from_lineage(lineage).snapshot_sha256
    if experiment.dataset_snapshot_sha256 != expected_snapshot:
        raise ValueError("experiment dataset_snapshot_sha256 does not match the research lineage snapshot")

    payload = experiment.model_dump(mode="python")
    references = list(payload.get("raster_inputs") or [])
    if references:
        raise ValueError(
            "this adapter supports one raster per dataset snapshot; compose multi-raster snapshots separately"
        )
    payload["raster_inputs"] = [lineage.raster_input_reference]
    try:
        return ExperimentManifest.model_validate(payload)
    except ValidationError as exc:
        raise ValueError("experiment manifest rejected the research raster lineage") from exc
