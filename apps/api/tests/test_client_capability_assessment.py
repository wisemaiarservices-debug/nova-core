from datetime import date

import pytest

from apps.api.services.client_configuration import (
    ClientConfiguration, CropProfile, LandArea, SiteProfile, TenantProfile,
)
from apps.api.services.equipment_capabilities import (
    CapabilityRegistry, EquipmentProfile, MeasurementCapability, SensorProfile,
)
from apps.api.services.model_applicability import (
    AvailableFeature, FeatureRequirement, ModelApplicabilityContract,
)
from apps.api.services.client_capability_assessment import (
    assess_client_capabilities, build_applicability_context,
)


def configuration(crops=None):
    tenant = TenantProfile(
        tenant_id="tenant-a", display_name="Example", configuration_version="v1"
    )
    site = SiteProfile(
        site_id="site-a", tenant_id="tenant-a", display_name="Field",
        configuration_version="v1", timezone="Africa/Tunis",
        land_area=LandArea(value=2, unit="ha"),
        crops=tuple(crops or [CropProfile(crop_id="crop-a", species="olive")]),
    )
    return ClientConfiguration(tenant=tenant, site=site)


def registry(tenant_id="tenant-a", site_id="site-a"):
    equipment = EquipmentProfile(
        equipment_id="sensor-housing", tenant_id=tenant_id, site_id=site_id,
        asset_class="sensor", protocol="mqtt",
    )
    sensor = SensorProfile(
        sensor_id="soil-1", equipment_id="sensor-housing",
        tenant_id=tenant_id, site_id=site_id, protocol="mqtt",
        measurements=(MeasurementCapability(metric="soil.moisture", unit="%"),),
    )
    return CapabilityRegistry(
        tenant_id=tenant_id, site_id=site_id, registry_version="v1",
        equipment=(equipment,), sensors=(sensor,),
    )


def model(lifecycle="research"):
    return ModelApplicabilityContract(
        model_id="olive-water", model_version="1.0", domain="agriculture",
        crop_scope="restricted", supported_crop_species=("olive",),
        climate_scope="unrestricted", equipment_scope="unrestricted",
        required_features=(FeatureRequirement(
            metric="soil.moisture", accepted_units=("%",),
            accepted_evidence_classes=("field_observation",),
        ),),
        lifecycle=lifecycle,
    )


def test_assessment_composes_config_and_registry_without_treating_sensor_as_observation():
    result = assess_client_capabilities(configuration(), registry(), model())
    assert result.assessment.status == "insufficient_data"
    assert result.assessment.missing_features == ("soil.moisture",)
    assert result.declared_metrics == ("soil.moisture",)
    assert result.assessment.recommendation == "abstain"


def test_explicit_evidence_feature_can_only_reach_research_only_without_validation():
    result = assess_client_capabilities(
        configuration(), registry(), model(),
        available_features=(AvailableFeature(
            metric="soil.moisture", unit="%", evidence_class="field_observation"
        ),),
    )
    assert result.assessment.status == "research_only"
    assert result.assessment.recommendation == "research_only"


def test_mixed_crop_site_does_not_arbitrarily_select_one_crop():
    config = configuration([
        CropProfile(crop_id="a", species="olive"),
        CropProfile(crop_id="b", species="tomato"),
    ])
    context = build_applicability_context(config, registry(), "agriculture")
    assert context.crop_species is None
    result = assess_client_capabilities(config, registry(), model())
    assert result.assessment.status == "needs_configuration"


def test_tenant_or_site_registry_mismatch_rejected():
    with pytest.raises(ValueError, match="tenant/site"):
        build_applicability_context(configuration(), registry(site_id="other"), "agriculture")


def test_land_area_is_converted_to_square_metres():
    context = build_applicability_context(configuration(), registry(), "agriculture")
    assert context.land_area_m2 == 20_000


def test_independently_validated_still_requires_explicit_features():
    validated = ModelApplicabilityContract(
        **{
            **model().model_dump(),
            "lifecycle": "independently_validated",
            "validation_record_reference": "validation-record-1",
        }
    )
    result = assess_client_capabilities(configuration(), registry(), validated)
    assert result.assessment.recommendation == "abstain"
