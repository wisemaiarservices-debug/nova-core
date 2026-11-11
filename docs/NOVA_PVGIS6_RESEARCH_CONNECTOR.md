# NOVA PVGIS 6 research connector

Status: implemented in draft PR #15; not deployed or scheduled.

## Endpoint

`GET /api/v1/data/solar/pvgis/performance`

Required query parameters:
- `latitude`: finite decimal degrees, -90 to 90
- `longitude`: finite decimal degrees, -180 to 180
- `start_date`: ISO date
- `end_date`: ISO date

The connector constrains the request to PVGIS' currently documented time-series window (2014–2025) and at most 367 calendar days. It calls the versioned JRC endpoint `/api/v6/performance/broadband` with the documented GET query parameters `latitude`, `longitude`, `start_time`, and `end_time`.

## Evidence interpretation

Every result is labelled `gridded_model_product`. PVGIS performance is a model-derived estimate informed by the provider's solar and meteorological datasets and calculation methods. It is not:
- measured inverter or meter production;
- a field observation or sensor reading;
- a verified site baseline;
- proof of savings, carbon reductions, yield, or operational improvement.

The connector preserves the provider JSON under `data` rather than guessing at a stable normalized schema. This is deliberate while PVGIS 6 remains beta and its API evolves. No downstream model should consume its output until a separately reviewed versioned mapper and conformance fixtures exist.

## Technical controls

- HTTPS and fixed provider host/path (no caller-supplied URL).
- 20-second request timeout.
- 2 MiB response cap.
- Reject redirects and non-JSON responses.
- Coordinate, date-window and period-length validation.
- No retries that could amplify provider load.
- No database writes, site registration, asset creation or source registration.
- No PVGIS 5 fallback.

## Current specification references

- PVGIS 6 Swagger/OpenAPI: https://photovoltaic-geographical-information-system.ec.europa.eu/api/v6/docs
- PVGIS 6 ReDoc: https://photovoltaic-geographical-information-system.ec.europa.eu/api/v6/redoc
- PVGIS release notes: https://photovoltaic-geographical-information-system.ec.europa.eu/api/release-notes
- JRC PVGIS 6 usage documentation: https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-6/using-pvgis_en

The 19 October 2026 release notes state that the API remains under versioned `/api/v6`, GET query names are retained, POST endpoint inputs belong in request bodies, response keys use snake_case, and time series extend through 2025. The provider describes the service as beta/actively under development. Recheck the OpenAPI document and release notes before changing this connector.

## Operational gate

A successful retrieval proves only that the provider returned a response for the explicitly supplied coordinates and dates. It does not create a pilot, prove the coordinates belong to NeoHaven, persist the data, validate a model, or authorize field action. A later ingestion pipeline must attach a verified source identity, retrieval timestamp, raw response hash, schema version, attribution and quality assessment before persistence or training.
