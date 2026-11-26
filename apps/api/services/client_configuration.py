"""Versioned, tenant-scoped client and site configuration contracts.

Contracts validate supplied configuration; they do not register tenants/sites,
authenticate users, infer missing specifications, or persist records.
"""
from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import date
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from apps.api.services.research_aoi import AOIValidationError, validate_research_aoi


class LandArea(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    value: float = Field(gt=0, le=1_000_000_000, allow_inf_nan=False)
    unit: Literal["m2", "ha", "km2", "acre"]

    @field_validator("value", mode="before")
    @classmethod
    def finite_positive_number(cls, value: Any) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("land area must be a numeric value")
        number = float(value)
        if not math.isfinite(number) or number <= 0 or number > 1_000_000_000:
            raise ValueError("land area must be finite, positive and within the supported numeric bound")
        return number

    @property
    def square_metres(self) -> float:
        factors = {"m2": 1.0, "ha": 10_000.0, "km2": 1_000_000.0, "acre": 4046.8564224}
        result = self.value * factors[self.unit]
        if not math.isfinite(result):
            raise ValueError("land area conversion exceeds the supported numeric range")
        return result


class TenantProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    tenant_id: str = Field(min_length=1, max_length=120)
    display_name: str = Field(min_length=1, max_length=160)
    configuration_version: str = Field(pattern=r"^v[1-9][0-9]*$")
    data_region: str | None = Field(default=None, max_length=80)


class CropProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    crop_id: str = Field(min_length=1, max_length=120)
    species: str = Field(min_length=1, max_length=120)
    cultivar: str | None = Field(default=None, max_length=120)
    growth_stage: Literal[
        "pre_planting", "establishment", "vegetative", "reproductive",
        "maturation", "harvest", "fallow", "unknown"
    ] = "unknown"
    planting_date: date | None = None
    expected_harvest_date: date | None = None

    @model_validator(mode="after")
    def validate_crop_dates(self) -> "CropProfile":
        if self.planting_date and self.expected_harvest_date:
            if self.expected_harvest_date < self.planting_date:
                raise ValueError("expected harvest date cannot precede planting date")
        return self


class IrrigationProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    method: Literal[
        "drip", "sprinkler", "surface", "subsurface_drip",
        "center_pivot", "micro_sprinkler", "rainfed", "mixed", "unknown"
    ] = "unknown"
    water_source: str | None = Field(default=None, max_length=160)
    design_flow_m3_per_hour: float | None = Field(default=None, gt=0, le=1_000_000, allow_inf_nan=False)

    @field_validator("design_flow_m3_per_hour", mode="before")
    @classmethod
    def finite_design_flow(cls, value: Any) -> Any:
        if value is None:
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ValueError("design flow must be a finite numeric value")
        return value


class EnergySystemProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    pv_capacity_kw: float | None = Field(default=None, gt=0, le=10_000_000, allow_inf_nan=False)
    inverter_capacity_kw: float | None = Field(default=None, gt=0, le=10_000_000, allow_inf_nan=False)
    battery_capacity_kwh: float | None = Field(default=None, gt=0, le=10_000_000, allow_inf_nan=False)
    battery_power_kw: float | None = Field(default=None, gt=0, le=10_000_000, allow_inf_nan=False)
    nominal_voltage_v: float | None = Field(default=None, gt=0, le=1_000_000, allow_inf_nan=False)
    grid_phase: Literal["single", "three", "dc", "off_grid", "unknown"] = "unknown"
    grid_connected: bool | None = None

    @field_validator(
        "pv_capacity_kw", "inverter_capacity_kw", "battery_capacity_kwh",
        "battery_power_kw", "nominal_voltage_v", mode="before"
    )
    @classmethod
    def finite_optional_ratings(cls, value: Any) -> Any:
        if value is None:
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ValueError("energy system ratings must be finite numeric values")
        return value


def _freeze_coordinate_tree(value: Any) -> Any:
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_coordinate_tree(item) for item in value)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    return value


class BoundaryGeometry(BaseModel):
    """Frozen GeoJSON boundary with recursively immutable coordinates."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["Polygon", "MultiPolygon"]
    coordinates: tuple[Any, ...]

    @field_validator("coordinates", mode="before")
    @classmethod
    def freeze_coordinates(cls, value: Any) -> tuple[Any, ...]:
        if not isinstance(value, (list, tuple)):
            raise ValueError("boundary coordinates must be an array")
        return tuple(_freeze_coordinate_tree(value))

    @model_validator(mode="after")
    def validate_bounded_geojson(self) -> "BoundaryGeometry":
        try:
            validate_research_aoi({"type": self.type, "coordinates": self.coordinates})
        except AOIValidationError as exc:
            raise ValueError(f"boundary GeoJSON is structurally invalid: {exc}") from exc
        return self


class MetadataEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    key: str = Field(min_length=1, max_length=80)
    value: str = Field(max_length=500)


class SiteProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    site_id: str = Field(min_length=1, max_length=120)
    tenant_id: str = Field(min_length=1, max_length=120)
    display_name: str = Field(min_length=1, max_length=160)
    configuration_version: str = Field(pattern=r"^v[1-9][0-9]*$")
    timezone: str = Field(min_length=1, max_length=80)
    land_area: LandArea | None = None
    boundary_geojson: BoundaryGeometry | None = None
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    region_label: str | None = Field(default=None, max_length=160)
    crops: tuple[CropProfile, ...] = Field(default_factory=tuple, max_length=100)
    irrigation: IrrigationProfile | None = None
    energy: EnergySystemProfile | None = None
    metadata: tuple[MetadataEntry, ...] = Field(default_factory=tuple, max_length=100)

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("timezone must be a valid IANA timezone identifier") from exc
        return value

    @field_validator("metadata", mode="before")
    @classmethod
    def freeze_metadata(cls, value: Any) -> Any:
        if value is None:
            return ()
        if isinstance(value, Mapping):
            return tuple(
                {"key": key, "value": item}
                for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
            )
        return value

    @model_validator(mode="after")
    def validate_site_configuration(self) -> "SiteProfile":
        if not self.tenant_id:
            raise ValueError("site must reference a tenant")
        keys = [item.key for item in self.metadata]
        if len(keys) != len(set(keys)):
            raise ValueError("site metadata keys must be unique")
        return self


class ClientConfiguration(BaseModel):
    """A versioned client/site bundle; unknown specs remain absent, never guessed."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    tenant: TenantProfile
    site: SiteProfile
    configuration_schema: Literal["nova-client-configuration-v1"] = "nova-client-configuration-v1"

    @model_validator(mode="after")
    def validate_tenant_site_match(self) -> "ClientConfiguration":
        if self.tenant.tenant_id != self.site.tenant_id:
            raise ValueError("site tenant_id must match the enclosing tenant profile")
        return self
