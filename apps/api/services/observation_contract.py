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
ECMASCRIPT_TRIM_CHARS = (
    "\\u0009\\u000a\\u000b\\u000c\\u000d\\u0020\\u00a0\\u1680"
    "\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007"
    "\\u2008\\u2009\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
)


def _validate_required_string(value: Any, maximum: int) -> Any:
    if not isinstance(value, str):
        raise ValueError("value must be a string")
    utf16_length = len(value.encode("utf-16-le", errors="surrogatepass")) // 2
    if not value or value.strip(ECMASCRIPT_TRIM_CHARS) != value or utf16_length > maximum:
        raise ValueError("string is blank, trimmed, or exceeds the UTF-16 length limit")
    return value
QUALITY_FLAGS = {
    "estimated", "sensor_calibration_due", "sensor_fault",
    "outlier_suspected", "provider_fill_value", "manually_entered",
    "gridded_or_reanalysis", "time_alignment_uncertain",
}
METRIC_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{0,119}$")
UNIT_PATTERN = re.compile(r"^[A-Za-z0-9%°µμ/._ -]{1,48}$")


class ObservationProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = Field(min_length=1, max_length=120)
    acquisition_method: Literal[
        "sensor", "manual", "provider_api", "satellite", "model", "derived"
    ]
    source_record_ref: str | None = Field(default=None, max_length=240)

    @field_validator("provider", mode="before")
    @classmethod
    def validate_provider_string(cls, value: Any) -> Any:
        return _validate_required_string(value, 120)

    @field_validator("source_record_ref", mode="before")
    @classmethod
    def validate_source_record_ref_string(cls, value: Any) -> Any:
        return None if value is None else _validate_required_string(value, 240)


class ObservationSubmission(BaseModel):
    """Untrusted caller payload; server-owned trust fields are intentionally absent."""

    model_config = ConfigDict(extra="forbid")

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

    @field_validator("site_id", "source_id", mode="before")
    @classmethod
    def validate_required_identifier_strings(cls, value: Any) -> Any:
        return _validate_required_string(value, 120)

    @field_validator("asset_id", mode="before")
    @classmethod
    def validate_optional_asset_id_string(cls, value: Any) -> Any:
        return None if value is None else _validate_required_string(value, 120)

    @field_validator("idempotency_key", mode="before")
    @classmethod
    def validate_idempotency_key_string(cls, value: Any) -> Any:
        return _validate_required_string(value, 200)

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

    @field_validator("value", mode="before")
    @classmethod
    def require_numeric_value(cls, value: Any) -> Any:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("value must be a JSON number")
        if isinstance(value, int) and abs(value) > 9_007_199_254_740_991:
            raise ValueError("integer value exceeds the cross-runtime safe range")
        if isinstance(value, float) and value.is_integer() and abs(value) > 9_007_199_254_740_991:
            raise ValueError("integer value exceeds the cross-runtime safe range")
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
