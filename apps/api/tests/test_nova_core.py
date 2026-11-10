import pytest
from pydantic import ValidationError

from apps.api.main import SiteState, explain, forecast, impact_score, input_provenance, recommend, run_recommendation, simulate


def test_forecast_flags_high_heat_and_low_moisture_for_review():
    result = forecast(SiteState(temperature_c=39, soil_moisture_pct=31))
    assert result["heat_risk"] == "high_screening_flag"
    assert result["yield_risk"] == "review_required_heat_and_low_moisture"
    assert result["water_demand_delta_pct"] is None
    assert result["methodology"]["calibrated_model"] is False


def test_default_inputs_are_explicitly_marked_synthetic():
    result = input_provenance(SiteState())
    assert result["data_mode"] == "synthetic_defaults"
    assert result["synthetic_defaults_present"] is True
    assert result["caller_supplied_values_verified"] is False
    assert "temperature_c" in result["defaulted_fields"]


def test_partial_payload_is_marked_mixed():
    result = input_provenance(SiteState(temperature_c=32))
    assert result["data_mode"] == "mixed_synthetic_and_caller_supplied"
    assert result["provided_fields"] == ["temperature_c"]
    assert "soil_moisture_pct" in result["defaulted_fields"]


def test_full_payload_is_caller_supplied_but_unverified():
    state = SiteState(site_id="field-01", temperature_c=32, soil_moisture_pct=45, solar_kw=10, battery_soc_pct=80, water_use_m3_today=12, gateway_health_pct=95)
    result = input_provenance(state)
    assert result["data_mode"] == "caller_supplied_unverified"
    assert result["defaulted_fields"] == []
    assert result["caller_supplied_values_verified"] is False


def test_impact_is_not_fabricated_from_insufficient_inputs():
    result = impact_score(SiteState())
    assert result["status"] == "not_estimable_from_available_inputs"
    assert result["water_saved_m3"] is None
    assert result["energy_shifted_kwh"] is None
    assert result["carbon_reduction_kg"] is None


def test_recommendation_is_review_only_and_has_no_fake_confidence():
    rec = recommend(SiteState())
    assert rec.requires_operator_review is True
    assert rec.confidence is None
    assert "verify field conditions" in rec.title.lower()


def test_scenario_does_not_invent_an_optimized_outcome():
    result = simulate(SiteState())
    assert result["comparison_status"] == "optimized_case_not_estimable"
    assert result["optimized"] is None
    assert result["impact"]["water_saved_m3"] is None


def test_explanation_discloses_method_and_limits():
    result = explain(SiteState())
    assert result["requires_operator_review"] is True
    assert result["methodology"]["trained_machine_learning"] is False
    assert result["input_provenance"]["synthetic_defaults_present"] is True


@pytest.mark.parametrize("field,value", [("soil_moisture_pct", 101), ("battery_soc_pct", -1), ("gateway_health_pct", 101), ("solar_kw", -0.1), ("water_use_m3_today", -1)])
def test_physical_input_ranges_are_validated(field, value):
    with pytest.raises(ValidationError):
        SiteState(**{field: value})


def test_recommendation_endpoint_preserves_explicit_review_status():
    result = run_recommendation(SiteState())
    assert result["status"] == "review_required"
    assert result["recommendation"]["requires_operator_review"] is True
