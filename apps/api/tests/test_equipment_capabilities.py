from datetime import date

import pytest
from pydantic import ValidationError

from apps.api.services.equipment_capabilities import (
    CalibrationRecord,
    CapabilityRegistry,
    EngineeringRating,
    EquipmentProfile,
    MeasurementCapability,
    SensorProfile,
)


def _equipment(**overrides):
    values = {
        "equipment_id": "sensor-body-1",
        "tenant_id": "tenant-1",
        "site_id": "site-1",
        "asset_class": "sensor",
        "protocol": "modbus_rtu",
    }
    values.update(overrides)
    return EquipmentProfile(**values)


def _sensor(**overrides):
    values = {
        "sensor_id": "soil-probe-1",
        "equipment_id": "sensor-body-1",
        "tenant_id": "tenant-1",
        "site_id": "site-1",
        "protocol": "modbus_rtu",
        "measurements": (
            MeasurementCapability(
                metric="soil.moisture",
                unit="% VWC",
                minimum_value=0,
                maximum_value=100,
                resolution=0.1,
                sampling_interval_seconds=300,
            ),
        ),
    }
    values.update(overrides)
    return SensorProfile(**values)


def test_capability_registry_links_sensor_to_site_equipment():
    registry = CapabilityRegistry(
        tenant_id="tenant-1",
        site_id="site-1",
        registry_version="v1",
        equipment=(_equipment(),),
        sensors=(_sensor(),),
    )
    assert registry.sensors[0].connectivity_status == "not_connected"
    assert registry.sensors[0].calibration.status == "unknown"


def test_registry_rejects_unknown_equipment_reference_and_cross_tenant_records():
    with pytest.raises(ValidationError, match="must resolve"):
        CapabilityRegistry(
            tenant_id="tenant-1",
            site_id="site-1",
            registry_version="v1",
            equipment=(_equipment(),),
            sensors=(_sensor(equipment_id="missing"),),
        )
    with pytest.raises(ValidationError, match="match registry"):
        CapabilityRegistry(
            tenant_id="tenant-1",
            site_id="site-1",
            registry_version="v1",
            equipment=(_equipment(tenant_id="tenant-2"),),
        )


def test_measurement_ranges_and_sampling_are_bounded():
    with pytest.raises(ValidationError, match="minimum_value"):
        MeasurementCapability(metric="energy.power", unit="kW", minimum_value=10, maximum_value=2)
    with pytest.raises(ValidationError):
        MeasurementCapability(metric="energy.power", unit="kW", sampling_interval_seconds=0)


def test_sensor_metrics_must_be_unique_and_verified_requires_protocol():
    capability = MeasurementCapability(metric="energy.power", unit="kW")
    with pytest.raises(ValidationError, match="unique"):
        _sensor(measurements=(capability, capability))
    with pytest.raises(ValidationError, match="declared protocol"):
        _sensor(protocol="unknown", connectivity_status="verified")


def test_calibration_verification_requires_certificate_and_consistent_dates():
    with pytest.raises(ValidationError, match="certificate"):
        CalibrationRecord(status="current", independently_verified=True)
    with pytest.raises(ValidationError, match="cannot precede"):
        CalibrationRecord(
            last_calibrated_on=date(2026, 6, 1),
            next_calibration_due=date(2026, 5, 1),
        )


def test_equipment_ratings_preserve_explicit_units_and_source():
    profile = _equipment(
        asset_class="inverter",
        ratings=(
            EngineeringRating(
                name="rated_ac_power",
                value=50,
                unit="kW",
                source_reference="manufacturer-datasheet-page-4",
                verification="manufacturer_document",
            ),
        ),
    )
    assert profile.ratings[0].value == 50
    assert profile.ratings[0].unit == "kW"
    assert profile.ratings[0].verification == "manufacturer_document"


def test_duplicate_equipment_ratings_are_rejected():
    rating = EngineeringRating(name="rated_power", value=10, unit="kW")
    with pytest.raises(ValidationError, match="unique"):
        _equipment(ratings=(rating, rating))


@pytest.mark.parametrize("value", [True, float("nan"), float("inf"), -float("inf")])
def test_measurement_capability_rejects_boolean_and_nonfinite_limits(value):
    with pytest.raises(ValidationError):
        MeasurementCapability(metric="sensor.value", unit="kW", minimum_value=value)
    with pytest.raises(ValidationError):
        MeasurementCapability(metric="sensor.value", unit="kW", resolution=value)
