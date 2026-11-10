"""Strict, side-effect-free observation request contract.

This module validates shape and basic semantics only. It does not authenticate
callers, authorize sites/sources, verify measurements, or persist observations.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MODULES = {"nova-core", "neoagro", "neogrid", "neocell"}
QUALITY_FLAGS = {
    "estimated", "sensor_calibration_due", "sensor_fault",
    "outlier_suspected", "provider_fill_value", "manually_entered",
    "gridded_or_reanalysis", "time_alignment_uncertain",
}
METRIC_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{0,119}$")
UNIT_PATTERN = re.compile(r"^[A-Za-z0-9%°µμ/._ -]{1,48}$")


class ObservationProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    provider: str = Field(min_length=1, max_length=120)
    acquisition_method: Literal[
        "sensor", "manual", "provider_api", "satellite", "model", "derived"
    ]
    source_record_ref: str | None = Field(default=None, max_length=240)


class ObservationSubmission(BaseModel):
    """Untrusted caller payload; server-owned trust fields are intentionally absent."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    site_id: str = Field(min_length=1, max_length=120)
    asset_id: str | None = Field(default=None, min_length=1, max_length=120)
    source_id: str = Field(min_length=1, max_length=120)
    module: Literal["nova-core", "neoagro", "neogrid", "neocell"]
    metric: str
    value: float
    unit: str
    observed_at: datetime
    idempotency_key: str = Field(min_length=1, max_length=200)
    provenance: ObservationProvenance
    quality_flags: list[str] = Field(default_factory=list, max_length=16)

    @field_validator("metric")
    @classmethod
    def validate_metric(cls, value: str) -> str:
        if not METRIC_PATTERN.fullmatch(value):
            raise ValueError("metric must be a lowercase identifier")
        return value

    @field_validator("unit")
    @classmethod
    def validate_unit(cls, value: str) -> str:
        if not UNIT_PATTERN.fullmatch(value):
            raise ValueError("unit contains unsupported characters")
        return value

    @field_validator("value")
    @classmethod
    def validate_finite_value(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("value must be finite")
        return value

    @field_validator("observed_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("observed_at must include an RFC 3339 timezone")
        return value.astimezone(timezone.utc)

    @field_validator("quality_flags")
    @classmethod
    def validate_quality_flags(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("quality_flags must not contain duplicates")
        unknown = sorted(set(values) - QUALITY_FLAGS)
        if unknown:
            raise ValueError(f"unsupported quality flag: {unknown[0]}")
        return values

    @model_validator(mode="after")
    def reject_future_observation(self) -> "ObservationSubmission":
        if self.observed_at > datetime.now(timezone.utc) + timedelta(minutes=5):
            raise ValueError("observed_at cannot be more than five minutes in the future")
        return self


def validate_observation_payload(payload: dict[str, Any]) -> ObservationSubmission:
    """Convenience boundary for callers and tests; performs no I/O or trust decisions."""
    return ObservationSubmission.model_validate(payload)
