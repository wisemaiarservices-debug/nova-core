from apps.api.main import SiteState, forecast, impact_score, recommend


def test_forecast_high_heat():
    result = forecast(SiteState(temperature_c=39, soil_moisture_pct=31))
    assert result["heat_risk"] == "high"
    assert result["water_demand_delta_pct"] == 18


def test_impact_score_positive():
    result = impact_score(SiteState())
    assert result["water_saved_m3"] >= 0
    assert result["carbon_reduction_kg"] > 0


def test_recommendation_operator_action():
    rec = recommend(SiteState())
    assert "irrigation" in rec.title.lower()
    assert rec.confidence > 0.5
