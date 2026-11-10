from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field


class SiteState(BaseModel):
    """Site inputs. Defaults are synthetic demo values, never live telemetry."""

    model_config = ConfigDict(extra="forbid")

    site_id: str = "site-solarhub-agro-001"
    temperature_c: float = Field(default=39, ge=-80, le=65)
    soil_moisture_pct: float = Field(default=31, ge=0, le=100)
    solar_kw: float = Field(default=42.6, ge=0)
    battery_soc_pct: float = Field(default=67, ge=0, le=100)
    water_use_m3_today: float = Field(default=18.4, ge=0)
    gateway_health_pct: float = Field(default=91, ge=0, le=100)


class Recommendation(BaseModel):
    title: str
    priority: str
    confidence: float | None = None
    explanation: str
    expected_impact: dict[str, Any]
    requires_operator_review: bool = True


app = FastAPI(title="NOVA Core API", version="0.2.0")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def input_provenance(state: SiteState) -> dict[str, Any]:
    """Distinguish request fields from synthetic defaults; caller data is unverified."""
    provided = sorted(state.model_fields_set)
    defaulted = sorted(set(type(state).model_fields) - set(provided))
    if not provided:
        mode = "synthetic_defaults"
    elif defaulted:
        mode = "mixed_synthetic_and_caller_supplied"
    else:
        mode = "caller_supplied_unverified"

    return {
        "data_mode": mode,
        "provided_fields": provided,
        "defaulted_fields": defaulted,
        "synthetic_defaults_present": bool(defaulted),
        "caller_supplied_values_verified": False,
        "note": (
            "Caller-supplied values are not independently verified. "
            "Default values are synthetic demonstration inputs, not sensor observations."
        ),
    }


def methodology() -> dict[str, Any]:
    return {
        "type": "deterministic_screening_rules",
        "version": "nova-screening-v0.2",
        "calibrated_model": False,
        "trained_machine_learning": False,
        "limitations": [
            "Screening thresholds are not crop-, cultivar-, soil-, or location-calibrated.",
            "No live weather, forecast, sensor, or external data source is connected.",
            "No measured intervention outcomes are available.",
            "Impact quantities cannot be estimated from the supplied fields alone.",
        ],
    }


def response_metadata(state: SiteState) -> dict[str, Any]:
    return {
        "input_provenance": input_provenance(state),
        "methodology": methodology(),
    }


def forecast(state: SiteState) -> dict[str, Any]:
    # These are transparent screening flags, not a calibrated forecast.
    heat_flag = state.temperature_c >= 37
    moisture_flag = state.soil_moisture_pct < 35
    return {
        "site_id": state.site_id,
        "heat_risk": "high_screening_flag" if heat_flag else "no_high_heat_flag",
        "water_demand_delta_pct": None,
        "solar_production_delta_pct": None,
        "yield_risk": (
            "review_required_heat_and_low_moisture"
            if heat_flag and moisture_flag
            else "not_assessed"
        ),
        "generated_at": now_iso(),
        **response_metadata(state),
    }


def impact_score(state: SiteState) -> dict[str, Any]:
    # These quantities require validated baselines and intervention measurements.
    return {
        "water_saved_m3": None,
        "energy_shifted_kwh": None,
        "carbon_reduction_kg": None,
        "yield_risk_reduction_pct": None,
        "resilience_gain_pct": None,
        "status": "not_estimable_from_available_inputs",
        "reason": (
            "Impact requires a defined baseline, intervention assumptions, "
            "measurement period, and relevant site-specific data."
        ),
    }


def recommend(state: SiteState) -> Recommendation:
    heat_flag = state.temperature_c >= 37
    moisture_flag = state.soil_moisture_pct < 35
    if heat_flag and moisture_flag:
        title = "Review irrigation need and verify field conditions"
        priority = "high_review"
        explanation = (
            "The screening rules flag high temperature together with low reported soil "
            "moisture. Verify sensor calibration, crop stage, root-zone conditions, "
            "recent rainfall, and local evapotranspiration before changing irrigation."
        )
    elif heat_flag:
        title = "Review heat conditions and monitor the field"
        priority = "medium_review"
        explanation = (
            "The temperature screening threshold has been crossed. This is not a "
            "crop-specific stress diagnosis; review local weather and field observations."
        )
    else:
        title = "Continue monitoring; no high-heat screening flag"
        priority = "routine"
        explanation = (
            "The configured high-heat screening threshold was not crossed. This does "
            "not establish that the crop or site is free from risk."
        )

    return Recommendation(
        title=title,
        priority=priority,
        confidence=None,
        explanation=explanation,
        expected_impact=impact_score(state),
        requires_operator_review=True,
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
    return {"status": "review_required", "recommendation": rec.model_dump(), "generated_at": now_iso(), **response_metadata(state)}


@app.post("/api/v1/scenarios/simulate")
def simulate(state: SiteState) -> dict[str, Any]:
    return {
        "site_id": state.site_id,
        "comparison_status": "optimized_case_not_estimable",
        "baseline": {"water_use_m3": state.water_use_m3_today, "source": "caller_supplied_or_synthetic_default"},
        "optimized": None,
        "impact": impact_score(state),
        "generated_at": now_iso(),
        **response_metadata(state),
    }


@app.post("/api/v1/assistant/explain")
def explain(state: SiteState) -> dict[str, Any]:
    rec = recommend(state)
    return {
        "what_is_happening": "NOVA has evaluated the supplied site values using deterministic screening rules.",
        "why_it_matters": "The flags can help prioritize field verification, but are not a validated crop-stress diagnosis or a site-specific forecast.",
        "what_happens_next": "No numeric demand forecast is issued until weather, crop, soil, and baseline data are available.",
        "what_to_do": rec.title,
        "expected_impact": rec.expected_impact,
        "requires_operator_review": True,
        "generated_at": now_iso(),
        **response_metadata(state),
    }
