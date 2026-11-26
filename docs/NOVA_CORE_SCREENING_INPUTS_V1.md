# NOVA Core screening inputs and abstention V1

## Contract

`SiteState` requires a caller-supplied `site_id` and treats every measurement as optional. Omitted measurements remain `None`; no SolarHub demo values, sample telemetry or synthetic baselines are inserted.

The site identifier is only a caller-provided selector. It does not prove that the site exists, belongs to the caller, or is registered to a tenant. Authentication, tenant membership and resource authorization remain separate release gates.

## Measurement validation

- Temperature: optional finite numeric value in -80..65 °C.
- Soil moisture: optional finite numeric value in 0..100%.
- Solar power: optional finite non-negative kW.
- Battery state of charge: optional finite numeric value in 0..100%.
- Daily water use: optional finite non-negative m³.
- Gateway health: optional finite numeric value in 0..100%.
- Booleans, numeric strings, non-numeric values, integer-to-float overflow, NaN and positive/negative infinity are rejected.
- Unknown fields are rejected. The model does not infer units, source, calibration, timestamp or sensor identity.

## Provenance and screening

- With no measurement values, input provenance is `insufficient_inputs`.
- With one or more supplied measurements, provenance is `caller_supplied_unverified`.
- Explicit null values are treated as missing, not as observations.
- A missing temperature produces no recommendation and a `not_assessed` priority. A soil-moisture value alone does not create a heat or irrigation diagnosis.
- A high-temperature flag is a deterministic screening threshold only. A low-moisture flag is used only when a soil-moisture value was supplied.
- All recommendations require operator review. Confidence is null; no calibrated or trained model is claimed.
- Impact quantities remain null because no baseline, intervention assumptions and measurement period are established.
- Scenario optimization is not generated from missing values or synthetic baselines.

## Limitations

Caller-supplied values are not independently verified. This contract does not authenticate the caller, validate site ownership, establish measurement provenance, check sensor calibration, fetch live weather, forecast yield, infer crop stress, estimate intervention impact, persist observations, or authorize irrigation/physical actuation.

The screening API must not be treated as a tenant-facing resource until the identity and authorization gates in the human Access design and tenant security contract are implemented.
