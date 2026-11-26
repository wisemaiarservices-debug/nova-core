"""Vendor-neutral sensor and equipment capability contracts.

These records describe capabilities and declared specifications only. They do
not prove device identity, calibration, installation, protocol interoperability,
or live connectivity.
"""
from __future__ import annotations

import math
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Protocol = Literal[
    "modbus_tcp", "modbus_rtu", "mqtt", "http_rest", "opc_ua",
    "lorawan", "bacnet_ip", "can_bus", "serial", "manual", "unknown"
]
EquipmentClass = Literal[
    "sensor", "gateway", "pv_module", "inverter", "battery",
    "energy_meter", "pump", "valve", "controller", "weather_station",
    "irrigation_controller", "other"
]


MAX_EQUIPMENT_PER_SITE = 5_000
MAX_SENSORS_PER_SITE = 10_000
MAX_RATINGS_PER_EQUIPMENT = 100
MAX_MEASUREMENTS_PER_SENSOR = 100
SENSOR_CAPABLE_EQUIPMENT_CLASSES = {\"sensor\", \"weather_station\", \"energy_meter\", \"other\"}


class MeasurementCapability(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    metric: str = Field(min_length=1, max_length=120, pattern=r"^[a-z][a-z0-9_.-]*$")
    unit: str = Field(min_length=1, max_length=48)
    minimum_value: float | None = None
    maximum_value: float | None = None
    resolution: float | None = Field(default=None, gt=0)
    accuracy_absolute: float | None = Field(default=None, ge=0)
    sampling_interval_seconds: float | None = Field(default=None, gt=0, le=31_536_000)
    output_kind: Literal["instantaneous", "interval_aggregate", "counter", "state", "unknown"] = "unknown"

    @field_validator("minimum_value", "maximum_value", "resolution", "accuracy_absolute", "sampling_interval_seconds", mode="before")
    @classmethod
    def finite_optional_measurement_values(cls, value: Any) -> Any:
        if value is None:
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("measurement capability values must be finite numbers")
        try:
            finite = math.isfinite(float(value))
        except (OverflowError, TypeError, ValueError):
            finite = False
        if not finite:
            raise ValueError("measurement capability values must be finite numbers")
        return value

    @model_validator(mode="after")
    def validate_declared_range(self) -> "MeasurementCapability":
        for field_name in ("minimum_value", "maximum_value"):
            value = getattr(self, field_name)
            if value is not None and not math.isfinite(value):
                raise ValueError(f"{field_name} must be finite")
        if self.minimum_value is not None and self.maximum_value is not None:
            if self.minimum_value >= self.maximum_value:
                raise ValueError("minimum_value must be less than maximum_value")
        return self


class CalibrationRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    status: Literal["current", "due", "overdue", "not_calibrated", "unknown"] = "unknown"
    last_calibrated_on: date | None = None
    next_calibration_due: date | None = None
    reference_standard: str | None = Field(default=None, max_length=160)
    certificate_reference: str | None = Field(default=None, max_length=240)
    independently_verified: bool = False

    @model_validator(mode="after")
    def validate_dates(self) -> "CalibrationRecord":
        if self.last_calibrated_on and self.next_calibration_due:
            if self.next_calibration_due < self.last_calibrated_on:
                raise ValueError("next calibration date cannot precede last calibration")
        if self.independently_verified and not self.certificate_reference:
            raise ValueError("verified calibration requires a certificate reference")
        if self.independently_verified and not self.last_calibrated_on:
            raise ValueError("verified calibration requires a last-calibrated date")
        return self


class EngineeringRating(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=100)
    value: float
    unit: str = Field(min_length=1, max_length=48)
    source_reference: str | None = Field(default=None, max_length=240)
    verification: Literal["manufacturer_document", "nameplate_observed", "operator_supplied", "unverified"] = "unverified"

    @field_validator("value", mode="before")
    @classmethod
    def finite_numeric_value(cls, value: Any) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("engineering rating must be numeric")
        try:
            number = float(value)
        except (OverflowError, TypeError, ValueError) as exc:
            raise ValueError("engineering rating must be finite") from exc
        if not math.isfinite(number):
            raise ValueError("engineering rating must be finite")
        return number


class EquipmentProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    equipment_id: str = Field(min_length=1, max_length=120)
    tenant_id: str = Field(min_length=1, max_length=120)
    site_id: str = Field(min_length=1, max_length=120)
    asset_class: EquipmentClass
    manufacturer: str | None = Field(default=None, max_length=160)
    model: str | None = Field(default=None, max_length=160)
    serial_number: str | None = Field(default=None, max_length=160)
    firmware_version: str | None = Field(default=None, max_length=120)
    protocol: Protocol = "unknown"
    ratings: tuple[EngineeringRating, ...] = Field(default=(), max_length=MAX_RATINGS_PER_EQUIPMENT)
    installed_on: date | None = None
    specifications_source_reference: str | None = Field(default=None, max_length=240)

    @model_validator(mode="after")
    def unique_rating_names(self) -> "EquipmentProfile":
        names = [rating.name for rating in self.ratings]
        if len(names) != len(set(names)):
            raise ValueError("equipment rating names must be unique")
        if any(rating.verification != "unverified" and not rating.source_reference for rating in self.ratings):
            raise ValueError("verified engineering ratings require a source reference")
        return self


class SensorProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    sensor_id: str = Field(min_length=1, max_length=120)
    equipment_id: str = Field(min_length=1, max_length=120)
    tenant_id: str = Field(min_length=1, max_length=120)
    site_id: str = Field(min_length=1, max_length=120)
    manufacturer: str | None = Field(default=None, max_length=160)
    model: str | None = Field(default=None, max_length=160)
    firmware_version: str | None = Field(default=None, max_length=120)
    protocol: Protocol = "unknown"
    measurements: tuple[MeasurementCapability, ...] = Field(min_length=1, max_length=MAX_MEASUREMENTS_PER_SENSOR)
    calibration: CalibrationRecord = Field(default_factory=CalibrationRecord)
    connectivity_status: Literal["not_connected", "configured", "connected_unverified", "verified"] = "not_connected"
    connectivity_evidence_reference: str | None = Field(default=None, max_length=240)
    connectivity_verified_at: datetime | None = None
    connectivity_verified_by: str | None = Field(default=None, max_length=160)

    @model_validator(mode="after")
    def unique_measurements(self) -> "SensorProfile":
        metrics = [item.metric for item in self.measurements]
        if len(metrics) != len(set(metrics)):
            raise ValueError("sensor measurement metrics must be unique")
        if self.connectivity_status == "verified":
            if self.protocol == "unknown":
                raise ValueError("verified connectivity requires a declared protocol")
            if not self.connectivity_evidence_reference or not self.connectivity_verified_by or not self.connectivity_verified_at:
                raise ValueError("verified connectivity requires evidence reference, verifier and timestamp")
            if self.connectivity_verified_at.tzinfo is None or self.connectivity_verified_at.utcoffset() is None:
                raise ValueError("connectivity verification timestamp requires a valid timezone offset")
        return self


class CapabilityRegistry(BaseModel):
    """Tenant/site-scoped inventory contract; not a live device registry."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    tenant_id: str = Field(min_length=1, max_length=120)
    site_id: str = Field(min_length=1, max_length=120)
    registry_version: str = Field(pattern=r"^v[1-9][0-9]*$")
    equipment: tuple[EquipmentProfile, ...] = Field(default=(), max_length=MAX_EQUIPMENT_PER_SITE)
    sensors: tuple[SensorProfile, ...] = Field(default=(), max_length=MAX_SENSORS_PER_SITE)

    @model_validator(mode="after")
    def validate_inventory_links(self) -> "CapabilityRegistry":
        equipment_ids = [item.equipment_id for item in self.equipment]
        sensor_ids = [item.sensor_id for item in self.sensors]
        if len(equipment_ids) != len(set(equipment_ids)):
            raise ValueError("equipment identifiers must be unique within a site registry")
        if len(sensor_ids) != len(set(sensor_ids)):
            raise ValueError("sensor identifiers must be unique within a site registry")
        equipment_lookup = {item.equipment_id: item for item in self.equipment}
        for item in (*self.equipment, *self.sensors):
            if item.tenant_id != self.tenant_id or item.site_id != self.site_id:
                raise ValueError("all inventory records must match registry tenant and site")
        for sensor in self.sensors:
            equipment = equipment_lookup.get(sensor.equipment_id)
            if equipment is None:
                raise ValueError("sensor equipment_id must resolve within this registry")
            if equipment.asset_class not in SENSOR_CAPABLE_EQUIPMENT_CLASSES:
                raise ValueError("sensor must reference a sensor-capable equipment record")
        return self
