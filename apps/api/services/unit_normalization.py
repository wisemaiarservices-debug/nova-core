"""Explicit, dimensional unit conversion for NOVA measurements.

Only units in the reviewed registry are converted. Unknown or dimensionally
incompatible units fail closed; original values and units remain available.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


@dataclass(frozen=True)
class UnitDefinition:
    dimension: str
    canonical_unit: str
    scale: float
    offset: float = 0.0

    def to_base(self, value: float) -> float:
        return value * self.scale + self.offset

    def from_base(self, value: float) -> float:
        return (value - self.offset) / self.scale


# Base representation is SI (or a clearly named canonical reference unit).
_UNITS: dict[str, UnitDefinition] = {
    # Temperature -> kelvin
    "K": UnitDefinition("temperature", "K", 1.0),
    "°C": UnitDefinition("temperature", "K", 1.0, 273.15),
    "degC": UnitDefinition("temperature", "K", 1.0, 273.15),
    "°F": UnitDefinition("temperature", "K", 5.0 / 9.0, 255.3722222222222),
    "degF": UnitDefinition("temperature", "K", 5.0 / 9.0, 255.3722222222222),
    # Length -> metre
    "m": UnitDefinition("length", "m", 1.0),
    "km": UnitDefinition("length", "m", 1000.0),
    "cm": UnitDefinition("length", "m", 0.01),
    "mm": UnitDefinition("length", "m", 0.001),
    "ft": UnitDefinition("length", "m", 0.3048),
    # Area -> square metre
    "m2": UnitDefinition("area", "m2", 1.0),
    "m²": UnitDefinition("area", "m2", 1.0),
    "ha": UnitDefinition("area", "m2", 10_000.0),
    "km2": UnitDefinition("area", "m2", 1_000_000.0),
    "km²": UnitDefinition("area", "m2", 1_000_000.0),
    "acre": UnitDefinition("area", "m2", 4046.8564224),
    # Volume -> cubic metre
    "m3": UnitDefinition("volume", "m3", 1.0),
    "m³": UnitDefinition("volume", "m3", 1.0),
    "L": UnitDefinition("volume", "m3", 0.001),
    "l": UnitDefinition("volume", "m3", 0.001),
    "mL": UnitDefinition("volume", "m3", 0.000001),
    # Flow -> cubic metre per second
    "m3/s": UnitDefinition("volume_flow", "m3/s", 1.0),
    "L/s": UnitDefinition("volume_flow", "m3/s", 0.001),
    "m3/h": UnitDefinition("volume_flow", "m3/s", 1.0 / 3600.0),
    "L/min": UnitDefinition("volume_flow", "m3/s", 0.001 / 60.0),
    # Power -> watt
    "W": UnitDefinition("power", "W", 1.0),
    "kW": UnitDefinition("power", "W", 1000.0),
    "MW": UnitDefinition("power", "W", 1_000_000.0),
    # Energy -> joule
    "J": UnitDefinition("energy", "J", 1.0),
    "Wh": UnitDefinition("energy", "J", 3600.0),
    "kWh": UnitDefinition("energy", "J", 3_600_000.0),
    "MWh": UnitDefinition("energy", "J", 3_600_000_000.0),
    # Electrical quantities
    "V": UnitDefinition("voltage", "V", 1.0),
    "mV": UnitDefinition("voltage", "V", 0.001),
    "kV": UnitDefinition("voltage", "V", 1000.0),
    "A": UnitDefinition("current", "A", 1.0),
    "mA": UnitDefinition("current", "A", 0.001),
    # Pressure -> pascal
    "Pa": UnitDefinition("pressure", "Pa", 1.0),
    "kPa": UnitDefinition("pressure", "Pa", 1000.0),
    "bar": UnitDefinition("pressure", "Pa", 100_000.0),
    # Speed -> metre per second
    "m/s": UnitDefinition("speed", "m/s", 1.0),
    "km/h": UnitDefinition("speed", "m/s", 1.0 / 3.6),
    # Ratio -> dimensionless fraction
    "fraction": UnitDefinition("ratio", "fraction", 1.0),
    "%": UnitDefinition("ratio", "fraction", 0.01),
    # Irradiance -> watt per square metre
    "W/m2": UnitDefinition("irradiance", "W/m2", 1.0),
    "W/m²": UnitDefinition("irradiance", "W/m2", 1.0),
    "kW/m2": UnitDefinition("irradiance", "W/m2", 1000.0),
    "kW/m²": UnitDefinition("irradiance", "W/m2", 1000.0),
}

_ALIASES = {
    "Celsius": "°C",
    "celsius": "°C",
    "Fahrenheit": "°F",
    "fahrenheit": "°F",
    "kelvin": "K",
    "square metre": "m2",
    "square meter": "m2",
    "hectare": "ha",
    "hectares": "ha",
    "litre": "L",
    "liter": "L",
    "cubic metre": "m3",
    "cubic meter": "m3",
    "percent": "%",
}


class Quantity(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    value: float
    unit: str = Field(min_length=1, max_length=48)

    @field_validator("value", mode="before")
    @classmethod
    def require_finite_number(cls, value: Any) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("quantity value must be numeric")
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("quantity value must be finite")
        return number

    @field_validator("unit")
    @classmethod
    def trim_unit(cls, value: str) -> str:
        return value.strip()


class NormalizedQuantity(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    original_value: float
    original_unit: str
    normalized_value: float
    normalized_unit: str
    dimension: str


def canonical_unit(unit: str) -> str:
    candidate = _ALIASES.get(unit.strip(), unit.strip())
    if candidate not in _UNITS:
        raise ValueError(f"unsupported unit: {unit}")
    return _UNITS[candidate].canonical_unit


def convert_value(value: float, source_unit: str, target_unit: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("conversion value must be a finite number")
    source_key = _ALIASES.get(source_unit.strip(), source_unit.strip())
    target_key = _ALIASES.get(target_unit.strip(), target_unit.strip())
    source = _UNITS.get(source_key)
    target = _UNITS.get(target_key)
    if source is None:
        raise ValueError(f"unsupported source unit: {source_unit}")
    if target is None:
        raise ValueError(f"unsupported target unit: {target_unit}")
    if source.dimension != target.dimension:
        raise ValueError(
            f"incompatible dimensions: {source.dimension} cannot convert to {target.dimension}"
        )
    result = target.from_base(source.to_base(float(value)))
    if not math.isfinite(result):
        raise ValueError("unit conversion produced a non-finite result")
    return result


def normalize_quantity(quantity: Quantity) -> NormalizedQuantity:
    source_key = _ALIASES.get(quantity.unit, quantity.unit)
    definition = _UNITS.get(source_key)
    if definition is None:
        raise ValueError(f"unsupported unit: {quantity.unit}")
    normalized = definition.to_base(quantity.value)
    return NormalizedQuantity(
        original_value=quantity.value,
        original_unit=quantity.unit,
        normalized_value=normalized,
        normalized_unit=definition.canonical_unit,
        dimension=definition.dimension,
    )
