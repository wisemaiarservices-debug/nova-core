import pytest
from pydantic import ValidationError

from apps.api.services.client_configuration import (
    ClientConfiguration, CropProfile, LandArea, SiteProfile, TenantProfile,
)
from apps.api.services.equipment_capabilities import (
    CalibrationRecord, CapabilityRegistry, EquipmentProfile,
    EngineeringRating, MeasurementCapability, SensorProfile,
)
from apps.api.services.client_onboarding_readiness import assess_client_onboarding_readiness


BOUNDARY = {
    "type": "Polygon",
    "coordinates": [[[10.0, 36.0], [10.1, 36.0], [10.1, 36.1], [10.0, 36.1], [10.0, 36.0]]],
}


def configuration(*, complete=False):
    tenant = TenantProfile(tenant_id="tenant-a", display_name="Client", configuration_version="v1")
    site = SiteProfile(
        site_id="site-a", tenant_id="tenant-a", display_name="Site",
        configuration_version="v1", timezone="Africa/Tunis",
        land_area=LandArea(value=3, unit="ha") if complete else None,
        boundary_geojson=BOUNDARY if complete else None,
        crops=(CropProfile(crop_id="crop-1", species="olive"),) if complete else (),
        irrigation=None if not complete else {"method": "drip"},
        energy=None if not complete else {"pv_capacity_kw": 20},
    )
    return ClientConfiguration(tenant=tenant, site=site)


def registry(*, complete=False, calibration_verified=True):
    equipment = EquipmentProfile(
        equipment_id="sensor-unit", tenant_id="tenant-a", site_id="site-a",
        asset_class="sensor", manufacturer="Acme" if complete else None,
        model="M1" if complete else None, protocol="mqtt",
        ratings=(EngineeringRating(
            name="supply_voltage", value=24, unit="V",
            source_reference="datasheet-1", verification="manufacturer_document",
        ),) if complete else (),
    )
    sensor = SensorProfile(
        sensor_id="soil-1", equipment_id="sensor-unit",
        tenant_id="tenant-a", site_id="site-a",
        manufacturer="Acme" if complete else None, model="S1" if complete else None,
        protocol="mqtt",
        measurements=(MeasurementCapability(metric="soil.moisture", unit="%"),),
        calibration=CalibrationRecord(
            status="current", independently_verified=calibration_verified,
            certificate_reference="certificate-1" if calibration_verified else None,
        ) if complete else CalibrationRecord(),
        connectivity_status="verified" if complete else "not_connected",
    )
    return CapabilityRegistry(
        tenant_id="tenant-a", site_id="site-a", registry_version="v1",
        equipment=(equipment,), sensors=(sensor,),
    )


def test_empty_client_profile_reports_explicit_information_gaps():
    result = assess_client_onboarding_readiness(configuration(), registry())
    assert result.status == "needs_information"
    codes = {issue.code for issue in result.issues}
    assert "site.land_area_missing" in codes
    assert "site.crops_missing" in codes
    assert "sensor.calibration_not_current" in codes
    assert result.declared_metric_count == 1


def test_complete_declared_and_verified_profile_is_only_ready_for_human_review():
    result = assess_client_onboarding_readiness(configuration(complete=True), registry(complete=True))
    assert result.status == "ready_for_review"
    assert result.issues == ()
    assert result.equipment_count == 1
    assert result.sensor_count == 1


def test_current_but_unverified_calibration_is_not_accepted_as_verified():
    result = assess_client_onboarding_readiness(
        configuration(complete=True), registry(complete=True, calibration_verified=False)
    )
    assert result.status == "needs_verification"
    assert "sensor.calibration_evidence_missing" in {issue.code for issue in result.issues}


def test_cross_tenant_or_site_inventory_is_rejected():
    with pytest.raises(ValueError, match="tenant/site"):
        assess_client_onboarding_readiness(configuration(), CapabilityRegistry(
            tenant_id="tenant-b", site_id="site-a", registry_version="v1"
        ))


def test_extra_unknown_fields_are_not_silently_accepted():
    with pytest.raises(ValidationError):
        CapabilityRegistry(
            tenant_id="tenant-a", site_id="site-a", registry_version="v1",
            unexpected="silently-ignored",
        )
