from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field


class SiteState(BaseModel):
    site_id: str = "site-solarhub-agro-001"
    temperature_c: float = 39
    soil_moisture_pct: float = 31
    solar_kw: float = 42.6
    battery_soc_pct: float = 67
    water_use_m3_today: float = 18.4
    gateway_health_pct: float = 91


class Recommendation(BaseModel):
    title: str
    priority: str
    confidence: float = Field(ge=0, le=1)
    explanation: str
    expected_impact: dict[str, Any]


app = FastAPI(title="NOVA Core API", version="0.1.0")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def forecast(state: SiteState) -> dict[str, Any]:
    heat_risk = "high" if state.temperature_c >= 37 else "medium"
    water_delta = 18 if heat_risk == "high" else 8
    solar_delta = -6 if state.temperature_c >= 37 else -2
    return {
        "site_id": state.site_id,
        "heat_risk": heat_risk,
        "water_demand_delta_pct": water_delta,
        "solar_production_delta_pct": solar_delta,
        "yield_risk": "medium_high" if heat_risk == "high" and state.soil_moisture_pct < 35 else "medium",
        "generated_at": now_iso(),
    }


def impact_score(state: SiteState) -> dict[str, Any]:
    return {
        "water_saved_m3": round(max(0, 35 - state.soil_moisture_pct) * 0.8, 2),
        "energy_shifted_kwh": 18,
        "carbon_reduction_kg": 7.5,
        "yield_risk_reduction_pct": 11,
        "resilience_gain_pct": 9 if state.gateway_health_pct >= 85 else 5,
    }


def recommend(state: SiteState) -> Recommendation:
    impact = impact_score(state)
    return Recommendation(
        title="Shift irrigation to evening window",
        priority="high" if state.temperature_c >= 37 else "medium",
        confidence=0.87,
        explanation=(
            "NOVA detected high heat risk, declining soil moisture, and a favorable energy window. "
            "Evening irrigation can reduce evaporation while coordinating with renewable energy availability."
        ),
        expected_impact=impact,
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "nova-core-api", "time": now_iso()}


@app.post("/api/v1/forecast/run")
def run_forecast(state: SiteState) -> dict[str, Any]:
    return forecast(state)


@app.post("/api/v1/recommendations/run")
def run_recommendation(state: SiteState) -> dict[str, Any]:
    rec = recommend(state)
    return {"status": "completed", "recommendation": rec.model_dump(), "generated_at": now_iso()}


@app.post("/api/v1/scenarios/simulate")
def simulate(state: SiteState) -> dict[str, Any]:
    return {
        "site_id": state.site_id,
        "baseline": {
            "water_use_m3": state.water_use_m3_today,
            "grid_dependency": "medium",
            "yield_risk": "medium_high",
        },
        "optimized": {
            "water_use_m3": round(state.water_use_m3_today - impact_score(state)["water_saved_m3"], 2),
            "grid_dependency": "lower",
            "yield_risk": "medium",
        },
        "impact": impact_score(state),
        "generated_at": now_iso(),
    }


@app.post("/api/v1/assistant/explain")
def explain(state: SiteState) -> dict[str, Any]:
    fc = forecast(state)
    rec = recommend(state)
    return {
        "what_is_happening": "The site is entering a high-heat operating window with declining soil moisture.",
        "why_it_matters": "Crop stress and evaporation risk are increasing while energy timing can still be optimized.",
        "what_happens_next": f"Water demand is expected to increase by {fc['water_demand_delta_pct']}%.",
        "what_to_do": rec.title,
        "expected_impact": rec.expected_impact,
        "generated_at": now_iso(),
    }
