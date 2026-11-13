# NOVA Measurement Quality Assessment Engine

## Scope

This change introduces a deterministic, evidence-gated assessment for an already persisted observation. It is not an AI model, an automatic correction engine, or a declaration that a measurement is scientifically true or safe.

## Required chain

A result of `passed` or `failed` requires all of the following at the observation timestamp:

1. The persisted observation has human `verified` status.
2. Exactly one latest-verified source-to-sensor mapping matches tenant, site, source, parameter, unit and effective interval. The mapping supplies the asset and sensor identity; source IDs are never treated as sensor IDs.
3. Exactly one latest-verified calibration matches that tenant, site, asset, sensor, parameter and unit, with calibration validity covering the observation timestamp.
4. Exactly one latest-verified customer policy matches the same tenant, site, asset, sensor, parameter and unit and is effective at the observation timestamp.
5. The stored numeric observation value is compared directly with the policy's explicit minimum and/or maximum. Boundaries are inclusive.

Missing, ambiguous, expired, unverified or mismatched prerequisites produce `not_assessed`; an out-of-bounds value produces `failed`. No default tolerance, unit conversion, interpolation, sensor correction, fuzzy identity matching or inferred policy is applied.

## Policy governance

A tenant owner/admin registers an immutable, versioned policy with explicit bounds, effective dates, method and evidence reference. A different, site-assigned measurement reviewer must verify, reject or revoke it. New limits require a new policy version; historical records are not overwritten. No universal agronomic, environmental or engineering threshold is supplied by NOVA.

## API

All endpoints are tenant-scoped and pass through the Access gateway and private Tenant API.

- `POST /api/v1/tenants/{tenant}/sites/{site}/assets/{asset}/measurement-quality-policies`
  - Owner/admin only. Registers a policy; it remains `registered_unverified`.
- `POST /api/v1/tenants/{tenant}/sites/{site}/assets/{asset}/measurement-quality-policies/{policy}/verification`
  - Site-granted member; reviewer must be assigned in the observation measurement-reviewer registry and cannot be the policy registrant. Body: `{ "decision": "verify|reject|revoke", "evidence_ref": "...", "reason": "..." }`. A reason is required for reject/revoke.
- `POST /api/v1/tenants/{tenant}/observations/{observation}/measurement-quality-assessment`
  - Site-granted reader; empty JSON object. Uses the server-persisted observation and server-resolved evidence only.

Assessment writes are append-only and request-idempotent. Original observations are not modified. D1 also rejects a passed/failed result unless the verified observation, latest-verified mapping, latest-verified calibration and latest-verified policy all match exactly and are effective at the observation time.

## Status meaning and limitations

- `passed`: the value is inside the explicitly approved bounds under the recorded method version.
- `failed`: the value is outside those bounds. This does not by itself mean unsafe, noncompliant or unusable.
- `not_assessed`: a prerequisite is missing, ambiguous, unverified, expired, mismatched or unsupported.

A human verification status is a governance/provenance state, not proof of accuracy. A registered lab PDF is not independently authenticated or accredited by this workflow. Calibration metadata does not establish metrological traceability by itself. No crop, irrigation, water-use, grid, cell or infrastructure recommendation is generated. Synthetic/demo/modelled provenance is not promoted to field evidence when explicitly labelled as such.

## Validation still required

Run the full NOVA Core CI suite, including ordered D1 migration application and local D1 integration. Confirm all route authorization and migration trigger cases before treating this as ready. This PR is draft-only and must not be merged or deployed without explicit approval.
