# NOVA Core API Runbook

## Run locally

```powershell
cd apps/api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements-dev.txt
uvicorn main:app --reload --port 8100
```

## Verify

```text
http://localhost:8100/health
```

## Endpoints

- POST `/api/v1/forecast/run`
- POST `/api/v1/recommendations/run`
- POST `/api/v1/scenarios/simulate`
- POST `/api/v1/assistant/explain`

## Test

```powershell
pytest
```

## Purpose

This service provides deterministic NOVA Core AI v0 for the SolarHub demo. It forecasts site risk, generates recommendations, simulates scenarios, scores impact, and explains the operator action.
