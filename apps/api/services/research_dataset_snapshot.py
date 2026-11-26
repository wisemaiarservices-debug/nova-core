"""Deterministic, provenance-bound research dataset snapshot fingerprints."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from apps.api.services.research_run_lineage import ResearchRunLineage


class ResearchDatasetSnapshot(BaseModel):
    """Immutable identity for the exact processed research input and interpretation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    dataset_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,79}$")
    dataset_version: str = Field(min_length=1, max_length=160)
    evidence_class: Literal["satellite_derived"] = "satellite_derived"
    provider: str = Field(min_length=1, max_length=120)
    mapset_code: str = Field(min_length=1, max_length=80)
    raster_code: str = Field(min_length=1, max_length=160)
    period_start: date
    period_end: date
    aoi_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    aoi_bbox: tuple[float, float, float, float]
    processed_window_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_object_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    provider_metadata_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    processing_code_commit: str = Field(pattern=r"^[a-f0-9]{40}$")
    processing_method: str = Field(min_length=1, max_length=120)
    width: int = Field(ge=1, le=100_000)
    height: int = Field(ge=1, le=100_000)
    source_width: int | None = Field(default=None, ge=1, le=100_000)
    source_height: int | None = Field(default=None, ge=1, le=100_000)
    source_dtype: str | None = Field(default=None, min_length=1, max_length=32)
    source_nodata: str | None = Field(default=None, max_length=64)
    valid_pixel_count: int = Field(ge=0, le=10_000_000)
    nodata_pixel_count: int = Field(ge=0, le=10_000_000)
    outside_aoi_pixel_count: int = Field(ge=0, le=10_000_000)
    raw_min: float | None = Field(default=None, allow_inf_nan=False)
    raw_max: float | None = Field(default=None, allow_inf_nan=False)
    raw_mean: float | None = Field(default=None, allow_inf_nan=False)
    scale: float | None = Field(default=None, allow_inf_nan=False)
    offset: float | None = Field(default=None, allow_inf_nan=False)
    scaled_min: float | None = Field(default=None, allow_inf_nan=False)
    scaled_max: float | None = Field(default=None, allow_inf_nan=False)
    scaled_mean: float | None = Field(default=None, allow_inf_nan=False)
    units: str | None = Field(default=None, max_length=80)
    crs_identifier: str | None = Field(default=None, min_length=3, max_length=120)
    geotransform: tuple[float, float, float, float, float, float] | None = None
    site_id: None = None

    @model_validator(mode="after")
    def validate_snapshot(self) -> "ResearchDatasetSnapshot":
        if self.period_end < self.period_start:
            raise ValueError("snapshot period end must not precede its start")
        pixel_count = self.width * self.height
        if pixel_count > 10_000_000:
            raise ValueError("snapshot window exceeds the 10 million pixel limit")
        if (self.source_width is None) != (self.source_height is None):
            raise ValueError("source dimensions must be paired")
        if self.source_width is not None and self.source_height is not None:
            if self.width > self.source_width or self.height > self.source_height:
                raise ValueError("snapshot window cannot exceed source dimensions")
        if self.valid_pixel_count + self.nodata_pixel_count + self.outside_aoi_pixel_count != pixel_count:
            raise ValueError("snapshot pixel counts must reconcile to window dimensions")

        raw = (self.raw_min, self.raw_max, self.raw_mean)
        if self.valid_pixel_count == 0:
            if any(value is not None for value in raw):
                raise ValueError("all-NoData snapshots require null raw statistics")
        else:
            if any(value is None for value in raw):
                raise ValueError("valid pixels require complete raw statistics")
            assert self.raw_min is not None and self.raw_max is not None and self.raw_mean is not None
            if self.raw_min > self.raw_max or not self.raw_min <= self.raw_mean <= self.raw_max:
                raise ValueError("raw statistics must satisfy min <= mean <= max")

        if (self.scale is None) != (self.offset is None):
            raise ValueError("scale and offset must be paired")
        scaled = (self.scaled_min, self.scaled_max, self.scaled_mean)
        if self.scale is not None and self.offset is not None and self.valid_pixel_count > 0:
            if any(value is None for value in scaled):
                raise ValueError("calibration requires complete scaled statistics")
            assert self.raw_min is not None and self.raw_max is not None and self.raw_mean is not None
            assert self.scaled_min is not None and self.scaled_max is not None and self.scaled_mean is not None
            expected = (
                self.raw_min * self.scale + self.offset,
                self.raw_max * self.scale + self.offset,
                self.raw_mean * self.scale + self.offset,
            )
            if not all(math.isfinite(value) for value in expected):
                raise ValueError("snapshot calibrated statistics must remain finite")
            expected_min, expected_max = sorted(expected[:2])
            if not (
                math.isclose(self.scaled_min, expected_min, rel_tol=1e-9, abs_tol=1e-12)
                and math.isclose(self.scaled_max, expected_max, rel_tol=1e-9, abs_tol=1e-12)
                and math.isclose(self.scaled_mean, expected[2], rel_tol=1e-9, abs_tol=1e-12)
            ):
                raise ValueError("snapshot scaled statistics do not match raw values, scale and offset")
        elif any(value is not None for value in scaled):
            raise ValueError("scaled statistics require explicit calibration and valid pixels")

        west, south, east, north = self.aoi_bbox
        if not all(math.isfinite(value) for value in self.aoi_bbox):
            raise ValueError("snapshot AOI bounds must be finite")
        if not (-180 <= west <= east <= 180 and -90 <= south <= north <= 90):
            raise ValueError("snapshot AOI bounds must be ordered WGS84 coordinates")
        if self.geotransform is not None and not all(math.isfinite(value) for value in self.geotransform):
            raise ValueError("snapshot geotransform values must be finite")
        return self

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
            aoi_bbox=lineage.aoi_bbox,
            processed_window_sha256=manifest.processed_window_sha256,
            source_object_sha256=manifest.source_object_sha256,
            provider_metadata_sha256=manifest.provider_metadata_sha256,
            processing_code_commit=manifest.processing_code_commit,
            processing_method=manifest.processing_method,
            width=manifest.width,
            height=manifest.height,
            source_width=manifest.source_width,
            source_height=manifest.source_height,
            source_dtype=manifest.source_dtype,
            source_nodata=manifest.source_nodata,
            valid_pixel_count=manifest.valid_pixel_count,
            nodata_pixel_count=manifest.nodata_pixel_count,
            outside_aoi_pixel_count=manifest.outside_aoi_pixel_count,
            raw_min=manifest.raw_min,
            raw_max=manifest.raw_max,
            raw_mean=manifest.raw_mean,
            scale=manifest.scale,
            offset=manifest.offset,
            scaled_min=manifest.scaled_min,
            scaled_max=manifest.scaled_max,
            scaled_mean=manifest.scaled_mean,
            units=manifest.units,
            crs_identifier=manifest.crs_identifier,
            geotransform=manifest.geotransform,
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
