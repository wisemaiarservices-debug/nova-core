from pydantic import ValidationError
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


def configuration(crops=None, land_area=None):
    tenant = TenantProfile(
        tenant_id="tenant-a", display_name="Example", configuration_version="v1"
    )
    site = SiteProfile(
        site_id="site-a", tenant_id="tenant-a", display_name="Field",
        configuration_version="v1", timezone="Africa/Tunis",
        land_area=land_area or LandArea(value=2, unit="ha"),
        crops=tuple(crops if crops is not None else [CropProfile(crop_id="crop-a", species="olive")]),
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
    assert result.model_id == "olive-water"


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


@pytest.mark.parametrize(("area", "expected"), [(2, 20_000), (0.5, 5_000), (100, 404_685.64224)])
def test_land_area_is_converted_to_square_metres(area, expected):
    unit = "ha" if area != 100 else "acre"
    context = build_applicability_context(
        configuration(land_area=LandArea(value=area, unit=unit)),
        registry(),
        "agriculture",
    )
    assert context.land_area_m2 == pytest.approx(expected)


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


def test_adapter_rejects_unvalidated_object_types_and_registry_scope_mismatch():
    with pytest.raises(ValueError, match="validated ClientConfiguration"):
        build_applicability_context({}, registry(), "agriculture")
    with pytest.raises(ValueError, match="validated CapabilityRegistry"):
        build_applicability_context(configuration(), {}, "agriculture")
    with pytest.raises(ValueError, match="validated ModelApplicabilityContract"):
        assess_client_capabilities(configuration(), registry(), {})


def test_sensor_declaration_never_becomes_available_observation():
    result = assess_client_capabilities(configuration(), registry(), model())
    assert result.declared_metrics == ("soil.moisture",)
    assert result.assessment.missing_features == ("soil.moisture",)
    assert result.assessment.unsupported_features == ()


def test_explicit_features_retain_evidence_class_gate():
    result = assess_client_capabilities(
        configuration(), registry(), model(),
        available_features=(AvailableFeature(
            metric="soil.moisture", unit="%", evidence_class="satellite_derived"
        ),),
    )
    assert result.assessment.status == "needs_configuration"
    assert result.assessment.recommendation == "abstain"
