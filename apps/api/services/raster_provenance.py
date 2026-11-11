"""Immutable provenance contract for bounded satellite-raster processing.

This module validates records supplied by a research workflow. It does not fetch,
persist, register or certify a raster, source, site, or experiment.
"""
from __future__ import annotations

import math
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


_SHA256 = r"^[a-f0-9]{64}$"
_COMMIT = r"^[a-f0-9]{40}$"
_CODE = r"^[A-Z0-9][A-Z0-9._-]{1,63}$"


class RasterProcessingManifest(BaseModel):
    """Reproducible record of one bounded WaPOR raster processing result."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    manifest_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{2,79}$")
    provider: Literal["FAO WaPOR"]
    dataset_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,79}$")
    dataset_version: str = Field(min_length=1, max_length=80)
    mapset_code: str = Field(pattern=_CODE)
    raster_code: str = Field(pattern=_CODE)
    provider_period_start: date
    provider_period_end: date
    retrieved_at: datetime
    source_object_sha256: str | None = Field(default=None, pattern=_SHA256)
    processed_window_sha256: str = Field(pattern=_SHA256)
    provider_metadata_sha256: str | None = Field(default=None, pattern=_SHA256)
    processing_code_commit: str = Field(pattern=_COMMIT)
    processing_method: Literal["nova-geotiff-strip-statistics-v1"]
    evidence_class: Literal["satellite_derived"] = "satellite_derived"

    # width/height describe the processed AOI crop; source dimensions preserve the full COG shape.
    width: int = Field(ge=1, le=100_000)
    height: int = Field(ge=1, le=100_000)
    source_width: int | None = Field(default=None, ge=1, le=100_000)
    source_height: int | None = Field(default=None, ge=1, le=100_000)
    valid_pixel_count: int = Field(ge=0, le=10_000_000)
    nodata_pixel_count: int = Field(ge=0, le=10_000_000)
    outside_aoi_pixel_count: int = Field(default=0, ge=0, le=10_000_000)

    raw_min: float | None = Field(default=None, allow_inf_nan=False)
    raw_max: float | None = Field(default=None, allow_inf_nan=False)
    raw_mean: float | None = Field(default=None, allow_inf_nan=False)
    scale: float | None = Field(default=None, allow_inf_nan=False)
    offset: float | None = Field(default=None, allow_inf_nan=False)
    scaled_min: float | None = Field(default=None, allow_inf_nan=False)
    scaled_max: float | None = Field(default=None, allow_inf_nan=False)
    scaled_mean: float | None = Field(default=None, allow_inf_nan=False)
    units: str | None = Field(default=None, min_length=1, max_length=48)

    # Optional normalized metadata; no CRS or affine transform is inferred here.
    crs_identifier: str | None = Field(default=None, min_length=3, max_length=120)
    geotransform: tuple[float, float, float, float, float, float] | None = None
    aoi_sha256: str | None = Field(default=None, pattern=_SHA256)
    aoi_bbox: tuple[float, float, float, float] | None = None

    # Research-only by construction; no customer site or registered source IDs.
    site_id: None = None

    @model_validator(mode="after")
    def validate_provenance_and_statistics(self) -> "RasterProcessingManifest":
        if self.provider_period_end < self.provider_period_start:
            raise ValueError("provider period end must not precede its start")
        if self.retrieved_at.tzinfo is None or self.retrieved_at.utcoffset() is None:
            raise ValueError("retrieved_at must include a valid timezone offset")

        pixel_count = self.width * self.height
        if pixel_count > 10_000_000:
            raise ValueError("processed window dimensions exceed the 10 million pixel limit")
        if (self.source_width is None) != (self.source_height is None):
            raise ValueError("source width and height must either both be present or both be absent")
        if self.source_width is not None and self.source_height is not None:
            if self.width > self.source_width or self.height > self.source_height:
                raise ValueError("processed window dimensions cannot exceed source raster dimensions")
        if self.valid_pixel_count + self.nodata_pixel_count + self.outside_aoi_pixel_count != pixel_count:
            raise ValueError("valid, NoData and outside-AOI pixel counts must equal window width multiplied by height")

        raw_values = (self.raw_min, self.raw_max, self.raw_mean)
        if self.valid_pixel_count == 0:
            if any(value is not None for value in raw_values):
                raise ValueError("all-NoData rasters must have null raw statistics")
        else:
            if any(value is None for value in raw_values):
                raise ValueError("rasters with valid pixels require min, max and mean statistics")
            assert self.raw_min is not None and self.raw_max is not None and self.raw_mean is not None
            if self.raw_min > self.raw_max or not self.raw_min <= self.raw_mean <= self.raw_max:
                raise ValueError("raw statistics must satisfy min <= mean <= max")

        calibrated = self.scale is not None and self.offset is not None
        if (self.scale is None) != (self.offset is None):
            raise ValueError("scale and offset must either both be present or both be absent")
        scaled_values = (self.scaled_min, self.scaled_max, self.scaled_mean)
        if calibrated and self.valid_pixel_count > 0:
            if any(value is None for value in scaled_values):
                raise ValueError("explicit calibration requires complete scaled statistics")
            assert self.scaled_min is not None and self.scaled_max is not None and self.scaled_mean is not None
            if self.scaled_min > self.scaled_max or not self.scaled_min <= self.scaled_mean <= self.scaled_max:
                raise ValueError("scaled statistics must satisfy min <= mean <= max")
        elif any(value is not None for value in scaled_values):
            raise ValueError("scaled statistics require explicit scale and offset plus valid pixels")

        if self.geotransform is not None and not all(math.isfinite(value) for value in self.geotransform):
            raise ValueError("geotransform values must be finite")
        if self.aoi_bbox is not None:
            west, south, east, north = self.aoi_bbox
            if not all(math.isfinite(value) for value in self.aoi_bbox):
                raise ValueError("AOI bounding-box coordinates must be finite")
            if not (-180 <= west <= east <= 180 and -90 <= south <= north <= 90):
                raise ValueError("AOI bounding box must use ordered WGS84 longitude/latitude bounds")
        return self
