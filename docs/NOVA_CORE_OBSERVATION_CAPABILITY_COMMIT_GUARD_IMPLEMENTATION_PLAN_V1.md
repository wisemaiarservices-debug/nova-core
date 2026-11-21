# NOVA Core observation capability commit-guard implementation plan v1

## Status and scope

Design-only follow-up to observation capability contract PR #308 and calibration profile registry PR #309. This document is an implementation gate, not evidence that observation enforcement is already active.

The next runtime change must make the D1 observation INSERT the final authority. Application preflight is for useful errors only. It must not authorize an observation independently of the database guard.

## Verified source facts

- The current ingestion payload accepts site, optional asset, source, module, metric, numeric value, unit, observed timestamp, idempotency key, provenance and quality flags.
- The current persistence function inserts only those fields plus server-derived tenant ownership and fixed `verification_status='unverified'`.
- The observation table currently has no first-class columns for measurement kind, acquisition protocol/version, sampling mode, or capability/profile identity.
- Capability records already carry tenant/site/source/optional asset/module/metric/unit, measured-or-derived semantics, protocol/version, sampling mode/interval, max age/future skew, timezone, allowed quality flags, calibration requirement/profile reference and approved/revoked lifecycle.
- Migration 0053 binds a calibration profile to an exact reviewed source-to-sensor mapping. Migration 0054 requires calibration-required capabilities to reference an exact profile.
- Calibration records are immutable. Their verification state is derived from the latest append-only verification event, not the mutable `verification_status` placeholder.
- Source verification, capability approval, mapping verification and calibration verification are distinct decisions. None implies another. Persisted observations remain `unverified`.

## Migration 0055: explicit observation evidence columns

Add nullable columns to preserve historical rows without pretending they passed the new contract:

- `source_capability_id`
- `measurement_kind`
- `acquisition_protocol`
- `protocol_version`
- `sampling_mode`
- `sampling_interval_seconds`
- `calibration_profile_ref`

New ingestion inserts after this migration must populate all capability metadata. A BEFORE INSERT guard rejects missing metadata; nullable columns are only a historical storage compatibility measure, not a bypass for new rows. Do not backfill or grandfather old observations into capabilities.

Add indexes for capability lookup and calibration/mapping joins only after reviewing query plans and D1 index costs.

## Exact-one capability decision at INSERT

The BEFORE INSERT guard must find exactly one row satisfying all of the following at commit time:

1. Capability status is currently `approved`; its latest lifecycle event is `approved`, not `revoked` or `rejected`.
2. Tenant, site, source, module, metric and unit exactly match the new observation.
3. Asset scope is exact: a site-level capability matches only a NULL observation asset; an asset-scoped capability matches only that same asset. No inheritance or fallback.
4. Measurement kind, acquisition protocol, protocol version and sampling mode exactly match.
5. For interval capabilities, the submitted interval value must equal the approved interval contract. Do not infer interval from timestamps.
6. The tenant, site, source and optional asset are active and source verification remains current.
7. The observation timestamp is not beyond the capability's future-skew allowance and is within its max-age window at ingestion. Use a consistent UTC instant comparison, not timezone display strings.
8. Every submitted quality flag is present in the capability's allowlist. Empty flags are valid only when allowed by the exact contract.

Reject zero matches and more than one match. Do not resolve ambiguity by choosing newest version or most permissive capability. The unique index should prevent overlapping versions for the same declared scope, but the trigger must still enforce exactly one eligible approved row after lifecycle state is considered.

## Sampling semantics — explicit unresolved rule

The current schema declares `sampling_mode` and `interval_seconds`, but does not define a cadence tolerance or whether interval means minimum spacing, target cadence, or aggregation window. Do not silently interpret it.

Before enforcing cadence, add a separately reviewed field/contract (for example a bounded tolerance or explicit interval semantics enum) and tests for delayed/batched delivery, duplicate retries, missing intervals and clock drift. Until then, enforce declared mode and exact interval metadata only; do not claim cadence conformance.

## Calibration-required path

For a capability with `calibration_required=1`, the same INSERT guard must resolve this entire chain using the observation's exact asset and observation instant:

1. The capability's exact `calibration_profile_ref` resolves to one immutable `source_calibration_profiles` row matching tenant/site/asset/source/parameter/unit.
2. The profile's mapping resolves to the exact `sensor_source_identity_mappings` row; its latest mapping review event is `verified`, not revoked/rejected; mapping effective interval contains the observation instant.
3. The mapping's sensor ID, parameter and unit match the calibration record.
4. A calibration record exists for the exact tenant/site/asset/sensor/parameter/unit.
5. The calibration's latest verification event is `verified`; a later `rejected` or `revoked` event disqualifies it.
6. The calibration interval covers the observation instant: `calibrated_at <= observed_at < valid_until`. The upper bound is exclusive.
7. Exactly one qualifying calibration record exists. Zero or multiple matches fail closed.

Use parsed UTC instants for comparisons and reject malformed timestamps. Existing timestamp text fields must be assessed for canonicalization; do not rely on lexical ordering across mixed offsets or formats. Do not equate a calibration profile with a calibration record ID.

For capabilities where calibration is not required, do not attach or infer a calibration record. The observation may still be accepted under the exact approved capability and remains unverified.

## Persistence and idempotency changes

Extend the validated payload and persisted observation columns together. The exact metadata fields must be included in the canonical payload comparison used for idempotency:

- Same source + idempotency key + identical complete payload returns the original observation.
- Same key with any changed capability/protocol/sampling/calibration/measurement metadata returns conflict.
- The observation and `observation.accepted` audit event remain one atomic D1 batch.
- A failed capability/calibration trigger must roll back both observation and audit insertion.
- The audit details should record the capability ID and declared evidence metadata without elevating observation verification status.
- Preserve the current server-derived tenant and authenticated service principal; never accept tenant/actor authority from the payload.

## Fixture and test cutover

Inventory every INSERT into `observations` across migrations, D1 fixtures, scripts, unit tests and integration tests. Classify each as:
- pre-0055 historical fixture (created before the guard is installed), or
- post-0055 new-ingestion fixture, which must use a valid approved capability or assert the expected rejection.

The shared D1 HTTP fixture currently inserts several observations before the capability fixture at the end. Reorder seed data or split fixtures so approved capabilities and their submitted/approved events exist before positive observation inserts. Do not disable triggers in tests.

Required positive tests:
- exact site-scoped capability;
- exact asset-scoped capability;
- measured and derived semantics;
- event and interval modes;
- allowed quality flags;
- non-calibrated capability;
- calibration-required capability with exact mapping and currently verified in-range calibration;
- exact upper/lower timestamp boundary behavior;
- identical retry returns the same ID without a second audit event.

Required negative tests:
- no capability, pending, rejected or revoked capability;
- ambiguous eligible capability;
- tenant/site/source/module/asset/metric/unit mismatch;
- protocol/version, measurement kind, sampling mode or interval mismatch;
- missing metadata, unknown or disallowed quality flags;
- inactive tenant/site/asset/source or source no longer verified;
- stale and future observations at both exact boundaries;
- mapping pending/rejected/revoked/outside effective interval;
- missing, wrong-sensor, wrong-asset, wrong-parameter or wrong-unit calibration;
- calibration pending/rejected/revoked, before `calibrated_at`, at/after `valid_until`, malformed time or ambiguous qualifying calibration;
- capability or calibration revocation between application preflight and the D1 INSERT;
- observation/audit rollback on a late audit trigger failure;
- concurrent identical retries and conflicting payloads with same idempotency key.

## Safe implementation sequence

1. Land and review the capability/profile registry prerequisites as a coherent stacked series; do not merge around missing base commits.
2. Add migration 0055 columns and small, explicit D1 triggers. Split triggers into separate migrations if SQLite/Wrangler parser limits recur.
3. Update payload validator, ownership checks, persistence and idempotency comparison in the same change series.
4. Update all post-0055 fixtures and scripts; retain explicit rejection tests for legacy-shaped writes.
5. Run ordered migrations from the beginning through 0055 in disposable local D1, then run the full gateway-to-private-Worker integration suite.
6. Require exact-head CI on the final SHA. No remote migration or deployment until a separate staging authorization and all release gates are satisfied.

## Explicit non-goals

- No scientific verification of individual observations.
- No automatic inference of source protocol, measurement kind, sampling mode, calibration or data rights.
- No global calibration, quality limits or cross-tenant defaults.
- No capability auto-approval or legacy grandfathering.
- No public endpoint, browser direct-D1 access, or frontend authority.
- No live D1, Cloudflare Access, Supabase, secrets, customer/device/provider data, staging or production changes in this design task.
