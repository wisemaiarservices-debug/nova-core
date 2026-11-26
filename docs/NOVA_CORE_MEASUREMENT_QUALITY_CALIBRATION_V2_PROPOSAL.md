# NOVA Core measurement quality and calibration contract — v2 proposal

**Status: design proposal only. Not accepted by the v1 ingestion endpoint.**

This document defines a versioned extension proposal for interoperable measurement context across NeoAgro, NeoGrid, NeoCell and future producers. It does not change the v1 payload, database schema, API routes, ingestion behavior or producer adapters. Until a separately reviewed implementation and migration exist, producers must continue sending only the v1 envelope documented in `NOVA_CORE_OBSERVATION_ENVELOPE_V1.md`.

## 1. Design goals

- Preserve raw measurement values and original source evidence; never silently repair or overwrite them.
- Separate producer assertions from Core-verified facts.
- Represent calibration, sampling, device identity, method, uncertainty and spatial support in a consistent shape.
- Permit unknown or inapplicable fields; missing metadata must not be fabricated.
- Make unit conversion explicit and reproducible, retaining the submitted value and unit.
- Keep scientific eligibility distinct from syntactic acceptance, source authentication and tenant authorization.
- Support different equipment, crops, site geometries, sensor vendors, protocols and sampling frequencies without customer-specific schema forks.
- Keep customer-specific calibration and configuration scoped to the customer/asset; never treat them as global model parameters.

## 2. Proposed envelope evolution

The v2 proposal adds one optional, structured `measurement_context` object to the v1 observation envelope. It is intentionally not accepted by the current v1 endpoint, which rejects unknown top-level keys.

Illustrative shape (all identifiers and values are placeholders, not registered records):

```json
{
  "contract_version": "2",
  "site_id": "registered-site-id",
  "asset_id": "registered-asset-id",
  "source_id": "registered-source-id",
  "module": "neogrid",
  "metric": "energy.active_power",
  "value": 12.4,
  "unit": "kW",
  "observed_at": "2026-11-12T12:00:00Z",
  "idempotency_key": "source-record-123",
  "provenance": {
    "provider": "registered-provider",
    "acquisition_method": "sensor",
    "source_record_ref": "source-record-123"
  },
  "quality_flags": [],
  "measurement_context": {
    "device": {
      "device_id": "registered-asset-id",
      "manufacturer": null,
      "model": null,
      "firmware_version": null,
      "gateway_id": null,
      "channel": null
    },
    "sampling": {
      "sampling_method": "instantaneous",
      "sample_count": 1,
      "interval_seconds": null,
      "window_start": null,
      "window_end": null,
      "aggregation_method": null
    },
    "calibration": {
      "status_claim": "unknown",
      "certificate_ref": null,
      "calibration_method": null,
      "calibrated_at": null,
      "due_at": null,
      "traceability_ref": null,
      "result": null
    },
    "uncertainty": {
      "value": null,
      "unit": null,
      "distribution": null,
      "coverage_factor": null,
      "confidence_level": null
    },
    "method": {
      "method_id": null,
      "method_version": null,
      "protocol": null
    },
    "spatial_support": {
      "kind": "asset",
      "geometry_ref": null,
      "coordinate_reference_system": null
    }
  }
}
```

The example is illustrative. A producer must not copy placeholder identifiers or claim a calibration status it cannot evidence.

## 3. Field semantics and validation

### Device identity

- `device_id` must resolve to a registered asset/device under the authenticated tenant and site.
- Manufacturer, model, firmware, gateway and channel are descriptive claims until checked against an approved device registry or signed device inventory.
- Serial numbers and other sensitive identifiers should remain in protected registry records; observation payloads should use opaque IDs.
- A gateway identity must not be inferred from an IP address or a user-supplied string.

### Sampling

- `sampling_method` is a controlled vocabulary: `instantaneous`, `periodic`, `interval_aggregate`, `event_driven`, `manual_sample`, or `unknown`.
- `sample_count` is a positive integer when known.
- `interval_seconds` is positive and bounded when applicable.
- `window_start` and `window_end` must be timezone-aware timestamps, with start strictly before end and the window containing or ending at the observation time according to the declared aggregation semantics.
- `aggregation_method` is a controlled vocabulary, for example `mean`, `min`, `max`, `sum`, `median`, `last`, or `none`. It is required for interval aggregates and must not be inferred.
- Sampling cadence and window semantics must be metric-aware; energy, water flow, soil moisture and weather measurements cannot all share an assumed cadence.

### Calibration

- `status_claim` is producer-asserted metadata only: `unknown`, `not_applicable`, `in_calibration`, `calibrated`, `overdue`, or `failed`.
- `certificate_ref` and `traceability_ref` are opaque references to evidence held in a controlled registry/document store; certificate contents must be independently verified before trusted use.
- `calibrated_at` and `due_at` are timezone-aware timestamps; due_at must not precede calibrated_at.
- `calibration_method` and `result` describe the evidence and outcome. Free text alone cannot establish traceability or calibration validity.
- Core-owned verification state is separate: `unverified`, `evidence_pending`, `verified`, `expired`, `rejected`. Only a controlled verification workflow may assign it.
- A calibration claim does not make a sensor accurate for every metric, range, environment or installation.

### Uncertainty

- Uncertainty must include a finite non-negative magnitude and a compatible unit.
- Distribution is controlled: `standard_uncertainty`, `expanded_uncertainty`, `interval`, or `unknown`.
- Coverage factor and confidence level are optional but constrained to valid finite ranges and are meaningful only with the relevant uncertainty method.
- Missing uncertainty remains unknown; no generic percentage is assigned by default.
- Unit compatibility and uncertainty propagation are evaluated by metric-specific methods, not by string matching alone.

### Method and protocol

- `method_id` and `method_version` identify the calculation, acquisition, laboratory, or processing method.
- `protocol` identifies the applicable sampling/communication protocol where relevant.
- Method identifiers resolve against a versioned registry. A producer-supplied label is not proof that the method was followed.

### Spatial support

- Spatial support distinguishes `site`, `asset`, `point`, `line`, `polygon`, `raster_cell`, and `unknown`.
- Geometry is referenced by an opaque registry ID or content-addressed artifact; arbitrary large geometry is not embedded in the observation envelope.
- Coordinate reference system must be explicit for geometry-based records.
- Site or asset geometry changes must be versioned so historical observations retain the geometry valid at observation time.
- A point measurement must not be treated as representative of an entire field or facility without a validated aggregation/spatial method.

## 4. Server-owned quality assessment

Do not accept a client-supplied numeric quality score or a client-supplied `verified` state.

Core should calculate and store separate dimensions, rather than one opaque score:

| Dimension | Example states | Evidence owner |
|---|---|---|
| Source identity | unknown, authenticated, revoked | Core identity registry |
| Ownership | unresolved, authorized, denied | Core tenant/site/source policy |
| Calibration | unknown, evidence_pending, verified, expired, failed | Calibration verification service |
| Temporal quality | unknown, acceptable, stale, future, misaligned | Core validation policy |
| Unit/metric compatibility | unknown, compatible, incompatible | Versioned metric registry |
| Sampling quality | unknown, sufficient, insufficient, inconsistent | Metric-specific validation |
| Spatial applicability | unknown, compatible, outside_scope | Geometry/method registry |
| Scientific eligibility | not_assessed, eligible_for_review, eligible, ineligible | Versioned scientific policy |

These dimensions must retain rule version, evidence references, assessed_at, and reason codes. A failed or unknown dimension must not be hidden by a high score in another dimension.

Scientific eligibility is not model training. Model readiness additionally requires documented target definition, data lineage, leakage-safe evaluation, independent validation, applicability envelope and monitoring.

## 5. Storage and governance implications

Before v2 acceptance is implemented:

1. Add a migration for structured context and server-owned assessment records, with tenant ownership and indexes reviewed for D1 query/write cost.
2. Store immutable raw submitted value/unit/timestamp and a canonical normalized representation with the conversion method/version.
3. Store evidence references and assessment history append-only; corrections should create superseding records, not rewrite the original observation.
4. Enforce tenant isolation on every evidence, device, calibration and assessment lookup.
5. Define retention, access control, export and deletion behavior for device identifiers and calibration documents.
6. Bound payload size, nesting depth, array lengths, string lengths and numeric ranges before persistence.
7. Add idempotency semantics for evidence updates and assessment events.
8. Use explicit migration ordering and test the full chain against both SQLite compatibility fixtures and an actual disposable Cloudflare D1 database before production use.

## 6. Compatibility and rollout gates

- v1 remains unchanged and strict.
- v2 must have an explicit route or media/version discriminator; do not infer versions from the presence of optional fields.
- Module adapters must have contract-parity tests against the Core validator. Core remains authoritative.
- Old producers continue to work on v1 until explicitly migrated.
- New fields are optional when legitimately unknown; conditional requirements are driven by the declared sampling method and metric definition.
- No producer is enabled by this proposal. Feature flags must default off until identity, tenant authorization, registry, storage, monitoring and rollback are ready.
- A valid v2 payload remains unverified until independent evidence checks complete.

## 7. Required test matrix

- Unknown keys, wrong types, oversized nesting/payload and non-finite values are rejected.
- Timestamp offsets, invalid calendar dates, future timestamps and sampling windows are tested.
- Sampling aggregates require the declared method and coherent count/window/interval.
- Calibration claims without evidence remain unverified; expired and failed evidence cannot be marked verified.
- Uncertainty units must be compatible with the observation unit and supported metric definition.
- Device, source, asset, geometry and evidence references cannot cross tenant or site boundaries.
- Unit normalization is deterministic, reversible where appropriate, and preserves the original submitted value.
- Replays are idempotent; changed payloads reusing an idempotency key conflict.
- Unknown metadata does not receive fabricated defaults or an invented quality score.
- v1 compatibility tests prove existing module producers and stored observations remain valid.

## 8. Explicit non-goals

This proposal does not create a universal calibration certificate standard, certify a sensor, infer missing metadata, define agronomic/electrical thresholds, generate a universal quality score, train a model, activate telemetry, create a database, provision Cloudflare resources, or deploy any Worker.
