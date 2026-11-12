# NOVA Core observation envelope v1

## Purpose and trust boundary

This is the canonical producer-to-Core payload contract implemented by
`apps/ingestion-worker/src/observation-contract.mjs`. It defines the accepted
shape and basic syntactic validation only. It does not authenticate a device,
prove that a source is genuine, establish calibration, validate scientific
accuracy, or make an observation suitable for a model.

The ingestion service remains authoritative for authentication, service/module/
source grants, active site/source/asset ownership, idempotency, persistence,
audit records and server-assigned verification status. Producer-supplied
provenance is a claim until independently verified.

## Endpoint and transport

- Method: `POST`
- Path: `/api/v1/observations`
- Transport: HTTPS through the protected ingestion Worker.
- Request body: bounded by the Worker to 32 KiB.
- Access: service-authenticated producer identity; never expose service-token
  credentials in browser code or public environment variables.
- The ingestion client must not follow redirects or forward credentials to a
  different host.

## Required envelope

```json
{
  "site_id": "registered-site-id",
  "asset_id": "registered-asset-id",
  "source_id": "registered-source-id",
  "module": "neoagro",
  "metric": "weather.air_temperature",
  "value": 24.5,
  "unit": "°C",
  "observed_at": "2026-11-10T12:00:00Z",
  "idempotency_key": "provider-record-123",
  "provenance": {
    "provider": "registered-provider",
    "acquisition_method": "provider_api",
    "source_record_ref": "provider-record-123"
  },
  "quality_flags": []
}
```

Required fields: `site_id`, `source_id`, `module`, `metric`, `value`,
`unit`, `observed_at`, `idempotency_key`, and `provenance`.
`asset_id` and `quality_flags` are optional; omitted quality flags become
an empty list. Unknown top-level and provenance keys are rejected.

## Field constraints

| Field | Contract |
|---|---|
| `site_id`, `source_id` | Non-empty ECMAScript-trimmed strings, maximum 120 UTF-16 code units |
| `asset_id` | Optional nullable non-empty ECMAScript-trimmed string, maximum 120 UTF-16 code units |
| `module` | One of `nova-core`, `neoagro`, `neogrid`, `neocell` |
| `metric` | Lowercase identifier matching `^[a-z][a-z0-9_.-]{0,119}$` |
| `value` | Finite JSON number; booleans, NaN, infinities and integer-valued numbers outside JavaScript's safe-integer range rejected |
| `unit` | 1–48 characters from the implementation's unit allowlist |
| `observed_at` | Calendar-valid RFC 3339 timestamp with timezone, Gregorian year 0001–9999; no more than 5 minutes in the future |
| `idempotency_key` | Non-empty ECMAScript-trimmed string, maximum 200 UTF-16 code units |
| `provenance.provider` | Non-empty ECMAScript-trimmed string, maximum 120 UTF-16 code units |
| `provenance.acquisition_method` | `sensor`, `manual`, `provider_api`, `satellite`, `model`, or `derived` |
| `provenance.source_record_ref` | Optional nullable non-empty ECMAScript-trimmed string, maximum 240 UTF-16 code units |

String limits use JavaScript UTF-16 code units, not Unicode code points. The
Python module adapters mirror this explicitly so astral characters cannot pass
client preflight and then fail or change meaning at the Core boundary. Required
strings use ECMAScript `String.trim()` whitespace semantics.

Integer-valued measurements must be within ±9,007,199,254,740,991
(`Number.MAX_SAFE_INTEGER`). This prevents JSON numbers from silently losing
integer precision when parsed by the Worker runtime. Fractional finite values
remain subject to the normal JSON/IEEE-754 representation.

Year zero is rejected; timestamps must use Gregorian years 0001–9999. This
keeps the Python adapter's datetime validation aligned with Core's calendar
checks.

The shared positive/negative regression matrix is stored at
`apps/ingestion-worker/test/fixtures/nova-core-observation-v1.json` and mirrored
byte-for-byte into the three module adapter test suites. Each implementation
runs the same accepted and rejected boundary cases before any transport call.

Allowed quality flags (maximum 16 unique values):

- `estimated`
- `sensor_calibration_due`
- `sensor_fault`
- `outlier_suspected`
- `provider_fill_value`
- `manually_entered`
- `gridded_or_reanalysis`
- `time_alignment_uncertain`

## Explicit v1 limitations

The v1 envelope does not yet carry structured sensor calibration certificates,
sampling intervals, device firmware, gateway identity, spatial geometry,
uncertainty distributions, method/version references, or a validated
scientific-quality score. Do not smuggle these into arbitrary fields: unknown
keys are rejected. Those capabilities require a separately versioned contract
and migration with compatibility tests.

A valid payload is not equivalent to verified telemetry. Successful acceptance
means the ingestion service accepted the event under its current trust and
storage checks; it does not mean the observation is calibrated, scientifically
validated, model-ready, or used to train a model.
