import pytest
from pydantic import ValidationError

from apps.api.services.model_applicability import (
    AvailableFeature,
    ClientApplicabilityContext,
    FeatureRequirement,
    ModelApplicabilityContract,
    assess_model_applicability,
)


def _model(**overrides):
    values = {
        "model_id": "neoagro-irrigation-screen-v1",
        "model_version": "1.0.0",
        "domain": "agriculture",
        "crop_scope": "restricted",
        "supported_crop_species": ("tomato", "wheat"),
        "climate_scope": "restricted",
        "supported_climate_zones": ("arid", "semi_arid"),
        "equipment_scope": "restricted",
        "supported_equipment_classes": ("soil_moisture_sensor", "weather_station"),
        "minimum_land_area_m2": 1000,
        "maximum_land_area_m2": 500_000,
        "required_features": (
            FeatureRequirement(
                metric="soil.moisture",
                accepted_units=("% VWC",),
                accepted_evidence_classes=("field_observation",),
            ),
        ),
        "lifecycle": "independently_validated",
        "validation_record_reference": "validation-report-001",
    }
    values.update(overrides)
    return ModelApplicabilityContract(**values)


def _context(**overrides):
    values = {
        "tenant_id": "tenant-1",
        "site_id": "site-1",
        "domain": "agriculture",
        "crop_species": "tomato",
        "climate_zone": "arid",
        "land_area_m2": 10_000,
        "equipment_classes": ("soil_moisture_sensor", "weather_station"),
        "available_features": (
            AvailableFeature(
                metric="soil.moisture",
                unit="% VWC",
                evidence_class="field_observation",
            ),
        ),
    }
    values.update(overrides)
    return ClientApplicabilityContext(**values)


def test_independently_validated_model_still_requires_human_review():
    result = assess_model_applicability(_model(), _context())
    assert result.status == "applicable_for_review"
    assert result.recommendation == "human_review_only"


def test_unknown_crop_climate_or_equipment_scope_abstains():
    result = assess_model_applicability(
        _model(crop_scope="unknown", climate_scope="unknown", equipment_scope="unknown"),
        _context(),
    )
    assert result.status == "needs_configuration"
    assert result.recommendation == "abstain"


@pytest.mark.parametrize(
    ("context", "reason"),
    [
        ({"crop_species": "rice"}, "crop species"),
        ({"climate_zone": "tropical"}, "climate zone"),
        ({"land_area_m2": 600_000}, "land area exceeds"),
        ({"domain": "energy"}, "outside the model domain"),
        ({"equipment_classes": ("inverter",)}, "equipment classes"),
    ],
)
def test_out_of_scope_client_profile_abstains(context, reason):
    result = assess_model_applicability(_model(), _context(**context))
    assert result.status == "not_applicable"
    assert result.recommendation == "abstain"
    assert any(reason in item for item in result.reasons)


def test_missing_features_and_wrong_units_or_evidence_abstain():
    missing = assess_model_applicability(_model(), _context(available_features=()))
    assert missing.status == "insufficient_data"
    assert missing.missing_features == ("soil.moisture",)

    wrong = assess_model_applicability(
        _model(),
        _context(available_features=(
            AvailableFeature(
                metric="soil.moisture",
                unit="fraction",
                evidence_class="satellite_derived",
            ),
        )),
    )
    assert wrong.status == "needs_configuration"
    assert len(wrong.unsupported_features) == 2


def test_research_model_never_becomes_applicable_for_review():
    model = _model(lifecycle="research", validation_record_reference=None)
    result = assess_model_applicability(model, _context())
    assert result.status == "research_only"
    assert result.recommendation == "research_only"


def test_independent_validation_requires_a_report_reference():
    with pytest.raises(ValidationError, match="validation record"):
        _model(validation_record_reference=None)


def test_invalid_scope_and_area_ranges_are_rejected():
    with pytest.raises(ValidationError, match="requires supported_crop_species"):
        _model(supported_crop_species=())
    with pytest.raises(ValidationError, match="minimum land area"):
        _model(minimum_land_area_m2=500_000, maximum_land_area_m2=1000)


def test_duplicate_context_features_and_nonfinite_area_are_rejected():
    feature = AvailableFeature(metric="soil.moisture", unit="% VWC", evidence_class="field_observation")
    with pytest.raises(ValidationError, match="unique"):
        _context(available_features=(feature, feature))
    with pytest.raises(ValidationError):
        _context(land_area_m2=float("inf"))
