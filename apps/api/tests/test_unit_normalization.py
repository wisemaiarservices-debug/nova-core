import math

import pytest
from pydantic import ValidationError

from apps.api.services.unit_normalization import (
    Quantity,
    canonical_unit,
    convert_value,
    normalize_quantity,
)


@pytest.mark.parametrize(
    ("value", "source", "target", "expected"),
    [
        (1, "ha", "m2", 10_000),
        (2, "km2", "ha", 200),
        (1, "acre", "m2", 4046.8564224),
        (1000, "L", "m3", 1),
        (3.6, "m3/h", "L/s", 1),
        (2, "kW", "W", 2000),
        (1.5, "MWh", "kWh", 1500),
        (230, "V", "kV", 0.23),
        (1, "bar", "kPa", 100),
        (36, "km/h", "m/s", 10),
        (50, "%", "fraction", 0.5),
        (1, "kW/m2", "W/m²", 1000),
    ],
)
def test_conversion_between_compatible_units(value, source, target, expected):
    assert convert_value(value, source, target) == pytest.approx(expected)


def test_temperature_conversions_handle_affine_offsets():
    assert convert_value(0, "°C", "K") == pytest.approx(273.15)
    assert convert_value(32, "°F", "°C") == pytest.approx(0)
    assert convert_value(100, "°C", "°F") == pytest.approx(212)


@pytest.mark.parametrize(
    ("source", "target"),
    [("ha", "kW"), ("°C", "mm"), ("L/s", "kWh"), ("V", "A")],
)
def test_incompatible_dimensions_are_rejected(source, target):
    with pytest.raises(ValueError, match="incompatible dimensions"):
        convert_value(1, source, target)


@pytest.mark.parametrize("unit", ["unknown-unit", "psi", "rpm", "mystery"])
def test_unknown_units_are_rejected_instead_of_guessed(unit):
    with pytest.raises(ValueError, match="unsupported"):
        canonical_unit(unit)


@pytest.mark.parametrize("value", [True, float("nan"), float("inf"), -float("inf")])
def test_quantity_rejects_boolean_and_nonfinite_values(value):
    with pytest.raises(ValidationError):
        Quantity(value=value, unit="kW")


def test_normalization_preserves_original_value_and_unit():
    result = normalize_quantity(Quantity(value=1.25, unit="ha"))
    assert result.original_value == 1.25
    assert result.original_unit == "ha"
    assert result.normalized_value == pytest.approx(12_500)
    assert result.normalized_unit == "m2"
    assert result.dimension == "area"


def test_normalization_aliases_and_whitespace_are_explicit():
    result = normalize_quantity(Quantity(value=20, unit=" Celsius "))
    assert result.normalized_value == pytest.approx(293.15)
    assert result.normalized_unit == "K"
    assert math.isfinite(result.normalized_value)


def test_temperature_normalization_returns_kelvin_base_value():
    result = normalize_quantity(Quantity(value=20, unit="°C"))
    assert result.normalized_unit == "K"
    assert result.normalized_value == pytest.approx(293.15)
