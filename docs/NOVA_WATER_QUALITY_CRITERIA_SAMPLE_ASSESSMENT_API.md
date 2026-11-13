# Database-backed water-quality sample comparison

## Route

`POST /api/v1/tenants/{tenant_id}/water-quality-criteria/{entry_id}/{version}/assess`

An active tenant member with a read role may request comparison. The request contains exactly `context` and `samples`. Context must exactly identify the route tenant, an existing site in that tenant, jurisdiction, crop ID, irrigation method and intended use. Batches contain 1–50 samples. Each sample may include an ID, parameter, finite numeric value, explicit unit, timezone-qualified sample timestamp and a provenance object. Provenance requires `source_type` (`measured`, `laboratory`, `modelled` or `synthetic`), `method` and `evidence_ref`. Laboratory samples also require `laboratory`; model-derived samples require `model`. Unknown provenance is not inferred.

## Execution

For each sample, the service loads the immutable registry entry and its persisted lifecycle/approval records, reconstructs the approved reviewer envelope, and invokes the existing exact-scope resolver for that sample's timestamp. Only an entry with a current lifecycle status of approved and an exact tenant/site/jurisdiction/crop/method/use/effective-date match is passed to the declared-criteria comparison utility.

Each criterion is mapped only to the exact request context after the registry resolver confirms that scope. The comparison utility performs no unit conversion, parameter aliasing, threshold fallback, interpolation or extrapolation. Missing, malformed, expired, unapproved, ambiguous or unsupported values remain `not_assessed`. Synthetic fixtures are always `not_assessed` and cannot be used to produce field-assessment outcomes. Measured, laboratory and model-derived provenance is returned as declared but `not_independently_verified`; a reference string does not authenticate the underlying evidence.

## Interpretation limits

- `within_declared_criterion` and `outside_declared_criterion` are arithmetic comparisons against the approved record's caller-supplied criterion only.
- They do not mean safe, unsafe, suitable, unsuitable, compliant or non-compliant.
- The service does not independently verify the source authority, document authenticity, current law, sample representativeness, laboratory accreditation or scientific suitability.
- `operational_decision` remains `not_authorized`. No irrigation, crop, treatment, allocation or infrastructure action is triggered.
- Results do not update model parameters or global rules. Criteria remain tenant/jurisdiction/site scoped.

## Validation

Unit tests cover within/outside arithmetic, pending registry rejection, malformed samples, missing provenance, laboratory/model identity requirements and synthetic-sample rejection. Local CI creates and approves a synthetic criteria fixture, then verifies synthetic samples remain `not_assessed` through the real Access gateway/private Worker Service Binding and disposable D1.
