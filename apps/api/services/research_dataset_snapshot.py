"""Deterministic, provenance-bound research dataset snapshot fingerprints."""
from __future__ import annotations

import hashlib
import json
from datetime import date
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from apps.api.services.research_run_lineage import ResearchRunLineage


class ResearchDatasetSnapshot(BaseModel):
    """Immutable content identity for one processed research dataset input.

    Retrieval timestamps and mutable URLs are intentionally excluded. The identity
    is based on data-window hashes and processing/provider metadata fingerprints.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    dataset_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,79}$")
    dataset_version: str = Field(min_length=1, max_length=160)
    evidence_class: str = "satellite_derived"
    provider: str = Field(min_length=1, max_length=120)
    mapset_code: str = Field(min_length=1, max_length=80)
    raster_code: str = Field(min_length=1, max_length=160)
    period_start: date
    period_end: date
    aoi_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    processed_window_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_object_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    provider_metadata_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    processing_code_commit: str = Field(pattern=r"^[a-f0-9]{40}$")
    processing_method: str = Field(min_length=1, max_length=120)
    width: int = Field(ge=1, le=100000)
    height: int = Field(ge=1, le=100000)
    valid_pixel_count: int = Field(ge=0)
    nodata_pixel_count: int = Field(ge=0)
    outside_aoi_pixel_count: int = Field(ge=0)
    units: str | None = Field(default=None, max_length=80)
    site_id: None = None

    @classmethod
    def from_lineage(cls, lineage: ResearchRunLineage) -> "ResearchDatasetSnapshot":
        manifest = lineage.raster_manifest
        return cls(
            dataset_id=manifest.dataset_id,
            dataset_version=manifest.dataset_version,
            provider=manifest.provider,
            mapset_code=manifest.mapset_code,
            raster_code=manifest.raster_code,
            period_start=manifest.provider_period_start,
            period_end=manifest.provider_period_end,
            aoi_sha256=lineage.aoi_sha256,
            processed_window_sha256=manifest.processed_window_sha256,
            source_object_sha256=manifest.source_object_sha256,
            provider_metadata_sha256=manifest.provider_metadata_sha256,
            processing_code_commit=manifest.processing_code_commit,
            processing_method=manifest.processing_method,
            width=manifest.width,
            height=manifest.height,
            valid_pixel_count=manifest.valid_pixel_count,
            nodata_pixel_count=manifest.nodata_pixel_count,
            outside_aoi_pixel_count=manifest.outside_aoi_pixel_count,
            units=manifest.units,
        )

    @property
    def snapshot_sha256(self) -> str:
        payload: dict[str, Any] = self.model_dump(mode="json")
        encoded = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @property
    def snapshot_id(self) -> str:
        return "nova-dataset-" + self.snapshot_sha256[:20]
