# NOVA Core — Cloud-First Development Audit

**Audit date:** 2026-11-10  
**Scope:** Read-only inspection of the current `main` branch and its documented API implementation.  
**Purpose:** Continue development through browser-based tools while local PC setup is unavailable.

## Executive summary

NOVA Core already has a small FastAPI service, a deterministic v0 decision workflow, a PostgreSQL/PostGIS/TimescaleDB-oriented schema, API run instructions, a pytest suite, and a GitHub Actions workflow. This is a useful starting point. It is not yet evidence of a production-ready or data-connected AI platform.

## Verified repository assets

- `apps/api/main.py`: FastAPI application with health, forecast, recommendation, scenario simulation, and assistant explanation endpoints.
- `apps/api/requirements.txt` and `requirements-dev.txt`: pinned runtime and test dependencies.
- `apps/api/tests/test_nova_core.py`: three unit tests for forecast, impact score, and recommendation title/confidence.
- `.github/workflows/ci.yml`: Python 3.12 CI job that installs development dependencies and runs pytest on pull requests and pushes to main.
- `database/nova_core_schema_v1.sql`: initial shared schema for organizations, sites, assets, relationships, digital twins, forecasts, and recommendations.
- `docs/ARCHITECTURE.md`, `docs/NOVA_AI_V0.md`, and `docs/NOVA_CORE_API_RUNBOOK.md`: architecture and run documentation.

## Findings and risks

### 1. Deterministic demo logic is present

The API uses deterministic Python rules. This is appropriate for a reliable v0 demonstration when clearly labelled. It should not be described as a trained predictive model or autonomous AI.

### 2. Default state and demo values need explicit labelling

`SiteState` currently supplies default values for a SolarHub-style site. Requests that omit fields silently use those values. This risks presenting demo assumptions as live site telemetry.

**Required improvement:** distinguish caller-supplied observations from demonstration defaults; include input provenance and an explicit demo/synthetic-data indicator in outputs.

### 3. Impact values are currently hard-coded

The impact calculation includes fixed energy-shift, carbon-reduction, and yield-risk values. The recommendation confidence is also fixed. These are illustrative outputs, not measured or calibrated impact estimates.

**Required improvement:** replace fixed values with transparent formulas whose assumptions and units are documented, or mark the values as illustrative and exclude them from real-world impact claims.

### 4. Forecast assumptions need traceability

The forecast uses fixed thresholds and percentage deltas. It does not currently expose the rule version, input completeness, assumptions, or limitations.

**Required improvement:** return rule identifiers, input summary, assumptions, limitations, and a confidence/quality explanation. Do not imply statistical forecast accuracy.

### 5. API validation and test coverage are limited

The visible test suite contains three direct function tests. It does not currently demonstrate endpoint-level validation, missing/invalid input handling, provenance, boundary cases, or API response contracts.

**Required improvement:** add FastAPI TestClient tests, boundary tests, explicit input constraints, and schema/contract checks.

### 6. Database schema is not yet demonstrated as connected

The SQL schema is present, but the inspected API implementation does not show database integration. The runbook starts the API without a database service.

**Required improvement:** document the current API as stateless until persistence is implemented and tested. Avoid claiming that the SQL schema is operationally connected.

### 7. CI exists but has not been executed in this audit

The workflow definition is present. This audit did not execute GitHub Actions or pytest, so no test pass is claimed.

## Recommended implementation sequence

1. Add explicit demo-data and provenance fields to the API contract.
2. Make impact calculations transparent and remove unsupported fixed impact claims.
3. Add endpoint-level tests using FastAPI TestClient.
4. Add boundary and missing-input tests for forecast and recommendation rules.
5. Add API response metadata: rule version, input provenance, limitations, and generation timestamp.
6. Verify GitHub Actions and record the actual run result.
7. Only then add external weather/agriculture data adapters and persistence.

## Cloud-first workflow

- Use GitHub Codespaces for full browser-based development when the free allowance is available.
- Use GitHub.dev for lightweight edits.
- Use Colab or Kaggle for isolated data/ML experiments, not as the production API host.
- Keep source code and tests in GitHub; keep secrets out of the repository.
- Use feature branches and pull requests. Do not experiment directly on `main`.

## Audit status

- Repository files inspected: yes.
- Runtime tests executed: no.
- CI run verified: no.
- Live external data integration verified: no.
- Database integration verified: no.
- Production readiness established: no.

## Next engineering task

Implement a small, backwards-conscious API contract improvement that labels default demo inputs and marks generated outputs as deterministic rule-based estimates. Add tests proving those labels are present. Keep all outputs operator-review-only; NOVA must not directly control critical infrastructure.
