# NOVA OS Module Integration Contract — V1

## 1. Purpose

NOVA OS is the operational shell that links NOVA Core to NeoAgro, NeoGrid and NeoCell. NOVA Core provides shared decision-support services and provenance conventions; domain modules retain ownership of their own domain data and APIs.

This document records the current integration boundary. It is not a claim that every module API is deployed or connected.

## 2. Service inventory and deployment truth

| Service | Verified endpoint / interface | Current status | Important limitation |
|---|---|---|---|
| NOVA Core API | `https://nova-core-api.neohaven.workers.dev/health` | Deployed Cloudflare Worker; health, NASA POWER retrieval and CORS smoke tests passed | Health means API process reachability only |
| NeoAgro web | `https://neoagro-six.vercel.app` | Existing product frontend | NASA POWER integration calls NOVA Core when configured; provider data is gridded/model- and satellite-derived, not ground-station telemetry |
| NeoGrid web | `https://neogrid-sigma.vercel.app` | Existing product frontend | Do not interpret frontend availability as energy API deployment or live meter connectivity |
| NeoGrid API | Contract paths listed below | Backend source and contract exist; public deployed API endpoint not verified | Current implementation is input screening; defaults are synthetic and caller values unverified |
| NeoCell web | `https://neocell-ebon.vercel.app` | Existing product frontend | Do not interpret frontend availability as gateway or sensor connectivity |
| NeoCell API | Contract paths listed below | Runtime source and contract exist; public deployed API endpoint not verified | No authenticated gateway or sensor feed; readiness assessment withheld |

Only NOVA Core's Worker endpoint is currently registered as a verified live API URL. Do not add guessed module API URLs to production configuration.

## 3. Ownership boundaries

### NOVA Core
- Shared API gateway and common data-provider adapters.
- Common provenance, validation, timestamp, unit and quality conventions.
- Shared site context only after an operator has selected and verified a site.
- Decision-support outputs with explicit methodology and limitations.

### NeoAgro
- Crop, soil, irrigation, water and agrivoltaic domain records.
- NASA POWER daily weather/solar retrieval through NOVA Core where configured.
- Clear separation between gridded provider data and field measurements.

### NeoGrid
- Energy sites, generation meters, inverters, battery BMS, loads, tariffs and grid import/export.
- Current API paths: `/health`, `/api/v1/dashboard/summary`, `/api/v1/forecasts/run`, `/api/v1/optimization/run`, `/api/v1/recommendations/run`.
- No forecast, dispatch plan or impact figure should be exposed as validated until required inputs and model evaluation exist.

### NeoCell
- Deployments, infrastructure modules, gateways, sensor nodes, maintenance events and edge device identity.
- Current API paths: `/health`, `/api/v1/dashboard/summary`, `/api/v1/readiness/analyze`, `/api/v1/plans/run`, `/api/v1/recommendations/run`.
- API health is not device health. No readiness score should be published without verified device inventory, calibrated telemetry and validated thresholds.

## 4. Shared observation envelope

Future module ingestion should normalize observations into the following logical envelope before persistence or cross-module use:

```json
{
  "observation_id": "provider-or-device-generated-id",
  "site_id": "operator-selected-site-id",
  "asset_id": null,
  "module": "neoagro|neogrid|neocell",
  "metric": "canonical_metric_name",
  "value": 0,
  "unit": "explicit-unit",
  "event_time": "RFC3339 timestamp",
  "ingested_at": "RFC3339 timestamp",
  "source": {
    "provider": "provider-or-device",
    "source_id": "registered-source-id",
    "method": "sensor|meter|provider_api|manual_entry|synthetic",
    "verification": "verified|unverified|synthetic"
  },
  "quality": {
    "status": "valid|suspect|missing|rejected",
    "flags": []
  },
  "schema_version": "1.0"
}
```

This is a target contract, not a claim that persistent ingestion is implemented. Nulls must remain null; missing values must not be silently interpolated. Raw observations should be immutable and corrections auditable.

## 5. Cross-module flow

1. An operator selects or creates a site and confirms its identity and coordinates.
2. A module registers a source and declares its source type, units, cadence, quality rules and ownership.
3. Ingestion authenticates the source and validates schema, timestamp, unit, range, duplicate/replay and quality flags.
4. NOVA Core stores or references the validated observation with provenance; domain modules remain authoritative for their own asset records.
5. Analytics may use only eligible observations and must publish methodology, input lineage, model version and validation status.
6. NOVA OS presents the result and routes the operator to the owning module for domain detail.
7. Any operational action remains a recommendation requiring authorized human review; no direct control of critical infrastructure is implied.

## 6. Minimum security requirements before live device integration

- Per-device identity and authorization; never accept unauthenticated public sensor writes.
- TLS in transit and secret storage outside source code.
- Key rotation and revocation, replay protection and request signing where appropriate.
- Rate limits, payload size limits and schema validation.
- Audit logs for source registration, observation correction and operator decisions.
- Separate read and write permissions; least privilege.
- No API tokens or raw credentials in browser-local storage.
- CORS is a browser policy, not authentication.

## 7. Current V1 readiness gates

- [x] NOVA Core Worker deployed and health endpoint verified.
- [x] NASA POWER daily provider retrieval smoke-tested through NOVA Core.
- [x] NeoAgro preview configured with NOVA Core base URL.
- [x] NeoGrid demo values and unsupported impact claims explicitly constrained in its draft provenance work.
- [x] NeoCell runtime draft labels synthetic and unverified inputs and withholds unsupported readiness/impact claims.
- [ ] NeoGrid API deployed and its public health endpoint verified.
- [ ] NeoCell API deployed and its public health endpoint verified.
- [ ] Shared persistent observation store and migration process.
- [ ] Authenticated device/source ingestion.
- [ ] Operator-selected pilot site and verified coordinates.
- [ ] Validated model datasets and evaluation reports.

## 8. Acceptance rule

A module is not considered connected merely because its website opens, its API process returns HTTP 200, or its dashboard renders. Mark a module API as connected only after its exact public endpoint is verified, a versioned contract smoke test passes, provenance is visible, and the endpoint's real capabilities are documented.
