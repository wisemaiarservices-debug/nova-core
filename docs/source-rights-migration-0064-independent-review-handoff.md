# Source rights migration 0064 — independent review handoff

**Review target:** `873086ea07779f349d47480847e3962a9ff4f9a0` (PR #311; review again if the head changes).

**Scope:** source-level review of migration 0064 and its interactions with migrations 0055, 0060–0063, source-capability lifecycle, observation persistence and idempotency. This is not a request to deploy, migrate a remote database, merge the PR or certify the whole platform.

## Required reviewer independence

The reviewer should not be an author of migration 0064 or its tests. The review record should identify the exact commit reviewed, reviewer, date, files inspected, findings, severity and disposition. A clean CI run is not an independent review.

## Review checklist

### A. Exact identity and scope
- [ ] Rights declaration ID resolves exactly from `source_capabilities.data_rights_ref`.
- [ ] Tenant, site and source match across capability, rights declaration and evidence document.
- [ ] Asset equality is NULL-safe and rejects NULL-vs-specific and cross-asset reuse.
- [ ] Observation scope matches the selected capability exactly.
- [ ] Capability `evidence_ref` equals the supporting evidence document ID.

### B. Lifecycle and effective time
- [ ] Only the latest rights lifecycle event may authorize approval/insertion; latest state must be `approved`.
- [ ] Only the latest evidence lifecycle event may authorize approval/insertion; latest state must be `verified`.
- [ ] Rights declaration and evidence document effective windows use inclusive start and exclusive end boundaries.
- [ ] Event ordering assumptions based on D1 rowid are valid for append-only event tables and cannot be bypassed by another writer.
- [ ] Revocation/withdrawal prevents future observations while leaving existing observation rows unchanged.

### C. Rights semantics and evidence integrity
- [ ] Supporting evidence ID, SHA-256 digest and exact scope bind the rights declaration to the document.
- [ ] Both `measurement_ingestion` and `storage` must be explicit.
- [ ] Analytics and model-training purposes are not inferred from ingestion/storage.
- [ ] Malformed or unexpected purpose JSON fails closed under the schema and trigger assumptions.

### D. Trigger interactions and write paths
- [ ] Migration 0064 preserves migration 0055 rejection precedence for missing capability identity and mismatched capability scope.
- [ ] All application and direct-SQL observation insert paths are subject to the same D1 trigger.
- [ ] No alternate writer, batch import or migration path bypasses the database guard.
- [ ] Capability approval and observation insertion are atomic with their relevant audit/idempotency records.
- [ ] Exact retries remain deterministic; changed-intent key reuse remains rejected.
- [ ] Rights/evidence lifecycle changes between approval and observation insertion are rechecked at insertion time.

### E. Migration and tests
- [ ] Migration ordering and trigger replacement behavior are correct from a clean database and an upgrade database.
- [ ] Positive, negative, boundary-time, cross-scope, missing-reference, purpose, revocation and historical-row tests are adequate.
- [ ] The test fixtures are synthetic and do not depend on production/customer data.
- [ ] CI evidence corresponds to the exact commit under review.

## Evidence currently available

- Exact-head CI: [44966562811](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44966562811), all three jobs passed on `873086ea07779f349d47480847e3962a9ff4f9a0`.
- Migration under review: `apps/api/migrations/0064_source_data_rights_capability_observation_guards.sql`.
- Guard tests: `apps/tenant-api/scripts/d1-source-rights-guard-tests.mjs`.
- Read-only aggregate inventory: `apps/tenant-api/scripts/read-only-source-rights-impact-inventory.sql`.

CI used disposable local D1. It is not evidence that remote staging or production has applied migration 0064.

## Review outcome template

Record one of:
- **Approved for staging impact assessment only** — no deployment or migration authorization implied.
- **Changes required** — list findings, affected paths/lines, severity and required regression tests.
- **Unable to conclude** — list missing evidence or environment assumptions.

A reviewer approval must not be represented as production readiness, a penetration test, legal approval or authorization to process customer data.

## Staging inventory safety gate

The inventory script is SELECT-only and aggregate-oriented. Before any remote staging execution:
1. Confirm the exact staging D1 database identity from authoritative environment configuration.
2. Obtain explicit written authorization for a read-only aggregate inventory.
3. Use a read-only execution identity and a staging-only route; do not use Wrangler `--remote` until the target is independently verified.
4. Record script SHA, target identity, execution time and aggregate output.
5. Do not retrieve or export document bytes, tenant/source names, raw telemetry, secrets or credentials.
6. Do not run against production. Do not migrate, repair, backfill or alter records as part of this assessment.

The inventory is diagnostic only. Any remediation, retroactivity decision or staging migration requires separate product/legal review and separate authorization.
