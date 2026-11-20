# NOVA Core Observation Capability Enforcement Contract v1

**Status:** implementation design / pre-cutover gate  
**Parent:** source capability lifecycle PR #307  
**Scope:** authenticated ingestion Worker and D1 observation insert boundary  
**Non-goals:** live device onboarding, remote D1 migration, Cloudflare deployment, scientific validation, or automatic actuation

## 1. Decision

Every newly inserted observation must match one currently approved source capability at commit time. Source verification alone is insufficient. Capability approval authorizes a bounded measurement scope; it does not scientifically verify an individual observation.

Enforcement must be additive and fail closed. There is no legacy-source bypass, fixture bypass, module-specific exception, or frontend-controlled authorization field. Existing rows remain historical records; the new guard applies to future INSERTs. A retry of an already persisted identical observation remains idempotent and must not create a new observation or audit event.

## 2. Existing implementation gap discovered

The current Worker payload contract carries site, optional asset, source, module, metric, value, unit, observed timestamp, idempotency key, provenance provider/acquisition method/source-record reference, and quality flags. It does **not** currently carry enough acquisition context to prove a match to every capability field:

- protocol identifier and protocol version;
- measured versus derived classification;
- sampling mode / interval context;
- calibration evidence or a resolvable calibration profile.

The current provenance schema is intentionally narrow. Do not infer a protocol from a provider name or map a generic acquisition method to a protocol identifier. Do not infer calibration from the mere presence of a source or asset.

The current persistence path resolves active site, verified source, and optional active asset, then batches an observation insert and audit insert. Migration 0035 rechecks active tenant/site and verified source in a BEFORE INSERT trigger, closing the source-revocation race. Migration 0042 and migrations 0043–0052 add capability definitions and governed lifecycle, but do not yet gate observations.

## 3. Required observation-to-capability match

At the D1 write boundary, select exactly one capability satisfying all of the following at the instant the observation is inserted:

1. status = approved; pending, rejected, and revoked versions are ineligible.
2. Exact tenant, site, source, module, metric, and unit match.
3. Exact asset scope: a site-level capability (asset_id IS NULL) matches only a site-level observation; an asset-scoped capability matches only that exact asset. No implicit site inheritance or cross-asset fallback.
4. Source is still verified and belongs to the same tenant/site/module; tenant and site are active; an optional asset is active and belongs to that tenant/site.
5. The observation timestamp parses as a valid instant, is no older than max_age_seconds, and is no further in the future than max_future_skew_seconds. These are elapsed-time rules; the capability timezone is descriptive for local acquisition schedules and must not alter instant comparisons.
6. Every submitted quality flag is present in the capability's JSON allowlist. An empty submitted list is valid unless a future contract explicitly makes a flag mandatory.
7. Acquisition protocol and version, measurement kind, and sampling mode match explicit observation metadata. Missing values are not guessed.
8. If calibration is required, the referenced profile must resolve to a currently valid, independently verified calibration for the exact mapped sensor/asset/parameter/unit and observation time. A non-empty string alone is not proof of calibration.

The application may perform an early read to return a useful error, but the D1 trigger is authoritative and must re-evaluate all mutable eligibility conditions during INSERT. A capability revoked between lookup and commit must not authorize the write.

## 4. Contract and schema changes required before enforcement

Extend the authenticated observation payload/provenance contract with explicit, validated fields for:
- acquisition protocol identifier;
- protocol version;
- measured/derived kind;
- sampling mode;
- calibration evidence/profile reference when required.

The exact JSON shape must be versioned and documented before implementation. Keep server-derived tenant identity out of the payload. Do not accept tenant, verification status, reviewer, capability ID, or approval status from the caller as authority. The server resolves the eligible capability; the caller cannot choose an arbitrary capability ID to bypass matching.

A capability must be unambiguous for its complete scope. If two approved capability versions overlap for the same exact scope, the insert guard must fail closed rather than choose an arbitrary row. Revocation and replacement must not create a window where an older approved version silently authorizes an incompatible measurement.

Calibration matching requires a documented stable relationship between calibration_profile_ref, source-to-sensor identity mapping, and verified calibration records. The current schema stores calibration against sensor identity, while capability stores a profile reference; the join semantics must be made explicit and tested before calibration_required=1 can be accepted.

## 5. Sampling and time semantics

- max_age_seconds and max_future_skew_seconds are checked against UTC instants at commit time.
- timezone is not a substitute for a timestamp offset and does not change elapsed-time arithmetic.
- sampling_mode=event has no interval.
- sampling_mode=interval requires a positive interval. The implementation must define whether this is a minimum spacing, a declared cadence, or a permitted timestamp grid. Do not silently treat the field as all three. The initial enforcement implementation should choose and document one deterministic rule and test boundary values.
- Use an injectable clock only in pure unit tests. The D1 trigger must use database time so the caller cannot supply a favorable clock.

## 6. Atomicity and idempotency

Observation and audit insertion remain one D1 batch. The capability guard runs on the observation INSERT within that batch. A failed capability guard must leave no observation and no audit row. An identical retry returns the original observation only after checking the stored row matches the submitted content; a changed payload under the same source/idempotency key remains a conflict.

Keep verification_status=unverified on every newly accepted observation. Capability approval is not measurement verification, regulatory certification, or scientific validation.

## 7. Required D1 and Worker test matrix

Positive:
- exact approved site-scoped capability;
- exact approved asset-scoped capability;
- explicit derived measurement capability;
- event and interval sampling cases under the selected cadence semantics;
- exact allowed quality flags;
- valid calibration-required case after calibration join semantics are implemented;
- identical idempotent retry with one audit event.

Negative:
- no capability; pending; rejected; revoked;
- tenant, site, source, asset, module, metric, or unit mismatch;
- inactive tenant/site/asset or source no longer verified;
- overlapping approved capabilities;
- stale timestamp, future timestamp beyond skew, malformed instant;
- disallowed quality flag;
- missing or mismatched protocol/version, measurement kind, sampling mode;
- interval boundary violation;
- missing, expired, unverified, or wrong-sensor calibration;
- capability revoked between application lookup and D1 INSERT;
- audit-trigger failure rolls back observation and audit together;
- concurrent identical and conflicting idempotency-key submissions;
- observation remains unverified after successful authorization.

Tests must run on the ordered disposable local D1 database after fixture seeding and before gateway integration. Negative tests must assert the intended trigger/constraint reason, not merely any non-zero process exit.

## 8. Fixture cutover inventory

Before enabling the global observation INSERT guard, inventory every observation INSERT in:
- ordered migrations and migration tests;
- apps/tenant-api/test/d1-http-fixtures.sql;
- local D1 HTTP integration scripts;
- ingestion Worker tests and any test-only seed SQL.

Historical rows inserted by earlier migrations remain untouched. Every observation inserted after migration 0053 in fixtures/tests must be accompanied by a matching approved capability created through the real lifecycle event path, or the test must explicitly assert rejection. Do not add a test-only bypass trigger, disable foreign keys, or weaken migration 0035. Seed ordering must create source identity and reviewer authority, then capability submission/approval, then observations.

The current HTTP fixture contains observations for multiple sources and legacy verified-status examples. Those rows must be reviewed individually; do not assume the single capability-http-a fixture covers them.

## 9. Rollout and acceptance gate

Implementation should be a separate draft PR stacked on PR #307. It must include:
- a new ordered migration after 0052;
- payload/provenance contract changes and compatibility tests;
- application capability lookup for clear errors;
- authoritative D1 insert guard;
- complete fixture/test cutover;
- exact-head CI evidence for all three jobs.

No live D1, Cloudflare, Supabase, staging, production, credentials, connected devices/providers, customer data, or paid resources are authorized by this design. Remote rollout remains blocked until a separately reviewed migration plan, tenant/source capability population, staging evidence, and release gates are approved.

## 10. Evidence boundary

This document is a design contract, not an implementation or security certification. It does not claim that current observations are capability-authorized. The current source-capability lifecycle PR #307 validates lifecycle storage and local D1 transition guards only.


## 11. Calibration profile relationship — concrete relational design

Read-only review of migrations 0012–0014 establishes three existing records with distinct responsibilities:

- `sensor_source_identity_mappings` binds one tenant/site/asset/source to a sensor identity, parameter and unit. Its mapping row is immutable; its append-only review events establish verified/rejected/revoked lifecycle.
- `sensor_calibrations` binds a tenant/site/asset/sensor/parameter/unit to an immutable calibration interval and evidence. Registration alone is not verification.
- `sensor_calibration_verification_events` records independent verified/rejected/revoked decisions. The latest event determines current eligibility; a historical verified event is not sufficient after a later revocation.

The capability's `calibration_profile_ref` must refer to a new immutable profile registry row, not directly to a calibration ID or mapping ID. Proposed additive table:

```sql
CREATE TABLE source_calibration_profiles (
  profile_ref TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  mapping_id TEXT NOT NULL,
  parameter TEXT NOT NULL,
  unit TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  created_by_subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (mapping_id, tenant_id, site_id, asset_id, source_id)
    REFERENCES sensor_source_identity_mappings
      (id, tenant_id, site_id, asset_id, source_id) ON DELETE RESTRICT
);
```

The production migration must first confirm that the exact composite parent key is accepted by SQLite/D1 (the mapping table defines this unique key). Add checks for bounded non-empty identifiers and evidence, a lookup index, immutable update/delete triggers, and an insert guard requiring an active tenant/site/asset plus a mapping whose latest review event is `verified`. Profile creation must not itself make a mapping verified or a calibration verified.

A capability with `calibration_required=1` must reference exactly one profile whose tenant/site/source/asset/parameter/unit matches the capability and whose mapping resolves to the same source, asset, metric/parameter and unit. The insert-time observation guard must then:

1. Resolve the profile and exact mapping; require the mapping's latest event (ordered by `occurred_at`, then insertion order) to be `verified`.
2. Resolve a calibration for the mapped sensor and exact tenant/site/asset/parameter/unit with `calibrated_at <= observed_at < valid_until` (the end boundary is exclusive).
3. Require that calibration's latest verification event to be `verified`; `registered`, `rejected`, or `revoked` is ineligible.
4. Require calibration evidence to remain linked to the same tenant/site and reject ambiguous multiple eligible calibrations rather than choosing arbitrarily.
5. Re-evaluate mapping and calibration lifecycle at the observation INSERT, not only during application preflight.

The profile is a stable identity bridge, not a cache of a calibration decision. It must not store a mutable `verified` boolean or copy a calibration status. A new calibration may satisfy the same profile only when it independently passes the exact scope, validity interval, and latest-event checks.

### Required calibration tests

- Profile insert with verified mapping succeeds; pending/rejected/revoked mapping fails.
- Cross-tenant, cross-site, cross-asset, cross-source, parameter or unit mismatch fails.
- Profile rows cannot be updated or deleted.
- Calibration registered but not reviewed fails.
- Verified calibration inside its interval succeeds; before calibrated_at or at/after valid_until fails.
- Later rejection/revocation invalidates the previously verified calibration.
- Wrong sensor identity, wrong asset, wrong parameter/unit, ambiguous valid calibrations fail closed.
- Mapping revoked after profile creation invalidates the profile at observation insert.
- Calibration revoked between preflight and observation INSERT is denied by the database guard.
- Audit failure rolls back the observation and its audit record.

This is a proposed schema contract only. It is not yet a migration and does not claim that calibration-required observations are currently enforceable.
