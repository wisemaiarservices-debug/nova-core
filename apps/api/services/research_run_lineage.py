"""Offline lineage contract linking a caller AOI to one processed WaPOR raster.

This contract joins existing validated objects; it does not fetch, persist, train,
or certify research data. The experiment registry can consume the emitted raster
input reference without trusting an unverified manifest store.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from apps.api.services.raster_provenance import RasterProcessingManifest
from apps.api.services.research_aoi import validate_research_aoi


def canonical_json_sha256(payload: Any) -> str:
    """Match the canonical JSON hashing convention used by the WaPOR runner."""
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class ResearchRunLineage(BaseModel):
    """Immutable, research-only link from explicit AOI to raster processing output."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: str = Field(pattern=r"^nova-research-[a-f0-9]{20}$")
    experiment_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{2,79}$")
    aoi_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    aoi_bbox: tuple[float, float, float, float]
    raster_manifest: RasterProcessingManifest
    evidence_class: str = "satellite_derived"
    site_id: None = None

    @model_validator(mode="after")
    def validate_linkage(self) -> "ResearchRunLineage":
        if self.evidence_class != "satellite_derived":
            raise ValueError("WaPOR research lineage must remain satellite_derived")
        if self.raster_manifest.evidence_class != "satellite_derived":
            raise ValueError("raster manifest evidence class must remain satellite_derived")
        if self.raster_manifest.site_id is not None:
            raise ValueError("research raster manifests must not identify a customer site")
        if self.raster_manifest.aoi_sha256 != self.aoi_sha256:
            raise ValueError("AOI checksum does not match the raster processing manifest")
        if self.raster_manifest.aoi_bbox != self.aoi_bbox:
            raise ValueError("AOI bounds do not match the raster processing manifest")
        return self

    @property
    def raster_input_reference(self) -> dict[str, str]:
        """Return the exact checksum-bound shape accepted by ExperimentManifest."""
        return {
            "manifest_id": self.raster_manifest.manifest_id,
            "dataset_id": self.raster_manifest.dataset_id,
            "processed_window_sha256": self.raster_manifest.processed_window_sha256,
            "evidence_class": "satellite_derived",
            **(
                {"source_object_sha256": self.raster_manifest.source_object_sha256}
                if self.raster_manifest.source_object_sha256 is not None
                else {}
            ),
        }


def build_research_run_lineage(
    experiment_id: str,
    aoi_geometry: dict[str, Any],
    raster_manifest: RasterProcessingManifest | dict[str, Any],
) -> ResearchRunLineage:
    """Validate and join explicit AOI and raster manifest into stable lineage."""
    summary = validate_research_aoi(aoi_geometry)
    manifest = (
        raster_manifest
        if isinstance(raster_manifest, RasterProcessingManifest)
        else RasterProcessingManifest.model_validate(raster_manifest)
    )
    aoi_hash = canonical_json_sha256(aoi_geometry)
    if manifest.aoi_sha256 != aoi_hash:
        raise ValueError("raster manifest was not produced for this exact AOI geometry")
    bbox = tuple(summary["bbox"])
    if manifest.aoi_bbox != bbox:
        raise ValueError("raster manifest AOI bounds do not match the supplied geometry")
    identity = {
        "experiment_id": experiment_id,
        "aoi_sha256": aoi_hash,
        "manifest_id": manifest.manifest_id,
        "processed_window_sha256": manifest.processed_window_sha256,
        "processing_code_commit": manifest.processing_code_commit,
    }
    run_id = "nova-research-" + canonical_json_sha256(identity)[:20]
    return ResearchRunLineage(
        run_id=run_id,
        experiment_id=experiment_id,
        aoi_sha256=aoi_hash,
        aoi_bbox=bbox,
        raster_manifest=manifest,
    )


def attach_lineage_to_experiment(experiment: BaseModel, lineage: ResearchRunLineage) -> BaseModel:
    """Return a revalidated experiment manifest carrying this exact raster input.

    The experiment type is supplied by the experiment-registry layer. Keeping this
    adapter structurally typed avoids duplicating that registry's model here.
    """
    required = ("dataset_id", "dataset_version", "dataset_snapshot_sha256", "evidence_class", "raster_inputs")
    if any(not hasattr(experiment, field) for field in required):
        raise ValueError("experiment must be a validated NOVA ExperimentManifest")
    raster = lineage.raster_manifest
    if experiment.dataset_id != raster.dataset_id:
        raise ValueError("experiment dataset_id does not match the research raster")
    if experiment.dataset_version != raster.dataset_version:
        raise ValueError("experiment dataset_version does not match the research raster")
    if experiment.evidence_class != "satellite_derived":
        raise ValueError("experiment evidence_class must be satellite_derived")
    from apps.api.services.research_dataset_snapshot import ResearchDatasetSnapshot

    snapshot = ResearchDatasetSnapshot.from_lineage(lineage)
    if experiment.dataset_snapshot_sha256 != snapshot.snapshot_sha256:
        raise ValueError("experiment dataset_snapshot_sha256 does not match the research snapshot")
    payload = experiment.model_dump(mode="python")
    references = list(payload.get("raster_inputs") or [])
    reference = lineage.raster_input_reference
    if any(item.get("manifest_id") == reference["manifest_id"] for item in references):
        raise ValueError("experiment already contains this raster manifest reference")
    references.append(reference)
    payload["raster_inputs"] = references
    try:
        return type(experiment).model_validate(payload)
    except Exception as exc:
        raise ValueError("experiment manifest rejected the research raster lineage") from exc
