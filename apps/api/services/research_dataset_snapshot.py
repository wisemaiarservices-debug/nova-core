"""Deterministic, provenance-bound research dataset snapshot fingerprints.

Retrieval timestamps and mutable provider download URLs are intentionally excluded.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

_SHA256 = r"^[a-f0-9]{64}$"
_COMMIT = r"^[a-f0-9]{40}$"
_MAPSET = r"^L[123]-[A-Z0-9-]{1,32}$"
_RASTER = r"^WAPOR-3\.L[123]-[A-Z0-9-]{1,32}\.\d{4}-\d{2}-D[1-3]$"
_DTYPE = r"^(?:u?int(?:8|16|32)|float(?:32|64))$"
_CRS = r"^(?:EPSG:[1-9][0-9]{0,5}|OGC:CRS84)$"


class ResearchDatasetSnapshot(BaseModel):
    """Immutable content identity for one processed WaPOR research raster window."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    dataset_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,79}$")
    dataset_version: str = Field(min_length=1, max_length=160)
    evidence_class: Literal["satellite_derived"] = "satellite_derived"
    provider: Literal["FAO WaPOR"]
    mapset_code: str = Field(pattern=_MAPSET)
    raster_code: str = Field(pattern=_RASTER)
    period_start: date
    period_end: date
    aoi_sha256: str = Field(pattern=_SHA256)
    aoi_bbox: tuple[float, float, float, float]
    processed_window_sha256: str = Field(pattern=_SHA256)
    source_object_sha256: str | None = Field(default=None, pattern=_SHA256)
    provider_metadata_sha256: str = Field(pattern=_SHA256)
    processing_code_commit: str = Field(pattern=_COMMIT)
    processing_method: Literal["nova-geotiff-strip-statistics-v1", "nova-wapor-cog-aoi-v1"]
    width: int = Field(ge=1, le=100_000)
    height: int = Field(ge=1, le=100_000)
    source_width: int | None = Field(default=None, ge=1, le=100_000)
    source_height: int | None = Field(default=None, ge=1, le=100_000)
    valid_pixel_count: int = Field(ge=0, le=10_000_000)
    nodata_pixel_count: int = Field(ge=0, le=10_000_000)
    outside_aoi_pixel_count: int = Field(ge=0, le=10_000_000)
    source_dtype: str | None = Field(default=None, pattern=_DTYPE)
    source_nodata: str | None = Field(default=None, max_length=64)
    crs_identifier: str | None = Field(default=None, pattern=_CRS)
    geotransform: tuple[float, float, float, float, float, float] | None = None
    scale: float | None = Field(default=None, allow_inf_nan=False)
    offset: float | None = Field(default=None, allow_inf_nan=False)
    raw_min: float | None = Field(default=None, allow_inf_nan=False)
    raw_max: float | None = Field(default=None, allow_inf_nan=False)
    raw_mean: float | None = Field(default=None, allow_inf_nan=False)
    scaled_min: float | None = Field(default=None, allow_inf_nan=False)
    scaled_max: float | None = Field(default=None, allow_inf_nan=False)
    scaled_mean: float | None = Field(default=None, allow_inf_nan=False)
    units: str | None = Field(default=None, max_length=48)
    site_id: None = None

    @model_validator(mode="after")
    def validate_snapshot_integrity(self) -> "ResearchDatasetSnapshot":
        if self.period_end < self.period_start:
            raise ValueError("snapshot provider period end must not precede its start")
        pixel_count = self.width * self.height
        if pixel_count > 10_000_000:
            raise ValueError("snapshot window exceeds the 10 million pixel limit")
        if self.valid_pixel_count + self.nodata_pixel_count + self.outside_aoi_pixel_count != pixel_count:
            raise ValueError("snapshot pixel counts must equal window width multiplied by height")
        if (self.source_width is None) != (self.source_height is None):
            raise ValueError("snapshot source dimensions must be paired")
        if self.source_width is not None and self.source_height is not None:
            if self.width > self.source_width or self.height > self.source_height:
                raise ValueError("snapshot window dimensions cannot exceed source dimensions")
        if self.source_object_sha256 is not None and self.source_width is None:
            raise ValueError("source-object checksum requires full source dimensions")
        if self.processing_method == "nova-wapor-cog-aoi-v1" and self.source_dtype is None:
            raise ValueError("WaPOR COG snapshots require source dtype metadata")
        if self.source_nodata is not None and not self.source_nodata.strip():
            raise ValueError("source NoData sentinel cannot be empty")
        if self.units is not None and not self.units.strip():
            raise ValueError("snapshot units cannot be empty")
        if self.crs_identifier == "EPSG:32767":
            raise ValueError("GeoTIFF user-defined CRS code 32767 is not an EPSG identifier")
        west, south, east, north = self.aoi_bbox
        if not all(math.isfinite(value) for value in self.aoi_bbox):
            raise ValueError("snapshot AOI bounds must be finite")
        if not (-180 <= west <= east <= 180 and -90 <= south <= north <= 90):
            raise ValueError("snapshot AOI bounds must be ordered WGS84 longitude/latitude")
        if self.geotransform is not None:
            if not all(math.isfinite(value) for value in self.geotransform):
                raise ValueError("snapshot geotransform must be finite")
            if self.crs_identifier is None:
                raise ValueError("snapshot geotransform requires an explicit CRS")
            _, pixel_x, rotation_x, _, rotation_y, pixel_y = self.geotransform
            determinant = pixel_x * pixel_y - rotation_x * rotation_y
            if not math.isfinite(determinant) or determinant == 0:
                raise ValueError("snapshot geotransform must have a non-zero affine determinant")

        raw_values = (self.raw_min, self.raw_max, self.raw_mean)
        if self.valid_pixel_count == 0:
            if any(value is not None for value in raw_values):
                raise ValueError("all-NoData snapshot windows must have null raw statistics")
        else:
            if any(value is None for value in raw_values):
                raise ValueError("valid snapshot pixels require raw min, max and mean")
            assert self.raw_min is not None and self.raw_max is not None and self.raw_mean is not None
            if self.raw_min > self.raw_max or not self.raw_min <= self.raw_mean <= self.raw_max:
                raise ValueError("snapshot raw statistics must satisfy min <= mean <= max")

        if (self.scale is None) != (self.offset is None):
            raise ValueError("snapshot scale and offset must be paired")
        scaled_values = (self.scaled_min, self.scaled_max, self.scaled_mean)
        if self.scale is not None and self.offset is not None and self.valid_pixel_count > 0:
            if any(value is None for value in scaled_values):
                raise ValueError("snapshot calibration requires complete scaled statistics")
            assert self.raw_min is not None and self.raw_max is not None and self.raw_mean is not None
            assert self.scaled_min is not None and self.scaled_max is not None and self.scaled_mean is not None
            endpoints = (self.raw_min * self.scale + self.offset, self.raw_max * self.scale + self.offset)
            expected_min, expected_max = min(endpoints), max(endpoints)
            expected_mean = self.raw_mean * self.scale + self.offset
            expected = (expected_min, expected_max, expected_mean)
            if not all(math.isfinite(value) for value in expected):
                raise ValueError("snapshot calibration exceeds the supported numeric range")
            if not (
                self.scaled_min <= self.scaled_mean <= self.scaled_max
                and math.isclose(self.scaled_min, expected_min, rel_tol=1e-9, abs_tol=1e-12)
                and math.isclose(self.scaled_max, expected_max, rel_tol=1e-9, abs_tol=1e-12)
                and math.isclose(self.scaled_mean, expected_mean, rel_tol=1e-9, abs_tol=1e-12)
            ):
                raise ValueError("snapshot scaled statistics do not match raw values and calibration")
        elif any(value is not None for value in scaled_values):
            raise ValueError("snapshot scaled statistics require explicit scale/offset and valid pixels")
        return self

    @classmethod
    def from_lineage(cls, lineage: Any) -> "ResearchDatasetSnapshot":
        from apps.api.services.research_run_lineage import ResearchRunLineage

        if not isinstance(lineage, ResearchRunLineage):
            raise TypeError("lineage must be a validated ResearchRunLineage")
        manifest = lineage.raster_manifest
        if manifest.provider_metadata_sha256 is None:
            raise ValueError("snapshot requires a provider metadata fingerprint")
        if lineage.site_id is not None:
            raise ValueError("research dataset snapshots cannot identify a customer site")
        return cls(
            dataset_id=manifest.dataset_id,
            dataset_version=manifest.dataset_version,
            evidence_class="satellite_derived",
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
            valid_pixel_count=manifest.valid_pixel_count,
            nodata_pixel_count=manifest.nodata_pixel_count,
            outside_aoi_pixel_count=manifest.outside_aoi_pixel_count,
            source_dtype=manifest.source_dtype,
            source_nodata=manifest.source_nodata,
            crs_identifier=manifest.crs_identifier,
            geotransform=manifest.geotransform,
            scale=manifest.scale,
            offset=manifest.offset,
            raw_min=manifest.raw_min,
            raw_max=manifest.raw_max,
            raw_mean=manifest.raw_mean,
            scaled_min=manifest.scaled_min,
            scaled_max=manifest.scaled_max,
            scaled_mean=manifest.scaled_mean,
            units=manifest.units,
        )

    @property
    def snapshot_sha256(self) -> str:
        payload = self.model_dump(mode="json")
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
