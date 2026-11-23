# Source rights migration 0064 — independent review handoff

**Current PR:** [NOVA Core #311](https://github.com/wisemaiarservices-debug/nova-core/pull/311)  
**Implementation head:** See the live PR head; this handoff is a historical review snapshot and does not certify the current commit.  
**Historical CI reference:** Run 45056756186 validated an earlier commit only; check the live PR for current exact-head CI.  
**Human review status:** Prior continuation approvals apply to earlier commits. Independent technical review of this exact head remains pending.

This handoff records the review scope and known limitations. It is not production certification or deployment authorization.

## 1. Review scope

Review migration 0064 and its interactions with:
- migration 0055 observation capability/calibration commit guard;
- migrations 0060–0063 evidence and data-rights governance, idempotency, revocation and effective windows;
- source capability lifecycle and persistence;
- observation persistence and idempotency;
- all supported observation write paths;
- disposable local D1 regression scripts;
- read-only aggregate impact inventory SQL.

Any code change after the reviewed commit requires review of the new exact head and a new exact-head CI run.

## 2. Confirmed implementation and test evidence

Migration 0064 adds database guards at capability approval and observation insertion. It checks exact rights declaration and evidence linkage, tenant/site/source/asset scope, current lifecycle state, effective windows, and explicit `measurement_ingestion` plus `storage` purposes.

Migration 0055 continues to enforce capability identity/scope, measurement metadata, quality flags, observation freshness and calibration requirements. Historical observations are not rewritten.

Exact-head CI run 45050072553 passed all four jobs. Tenant Worker tests applied ordered migrations and exercised governance paths against disposable local D1 with synthetic fixtures. Worker package readiness bundled code without deployment.

## 3. Known findings requiring explicit disposition

### Lifecycle re-approval
Unique event-type constraints on evidence and rights lifecycle records prevent re-verification/re-approval of the same record after revocation. The current policy requires a replacement evidence document or rights declaration for renewed authorization. Confirm that this is the intended product/legal lifecycle.

### Latest-event ordering
Latest lifecycle state is selected using append-only event rows ordered by rowid. Confirm that all writers preserve append-only semantics and that no alternate writer can manipulate ordering assumptions.

### Effective windows
Migrations 0060, 0062, 0063 and 0064 use SQLite `julianday()` comparisons for effective windows. Tests cover whole-second effective-from acceptance and existing expired-rights rejection. Exact start/end boundary and timezone-format coverage can be expanded.

### Asset and tenant scope
Migration 0064 uses NULL-safe equality for nullable asset scope and rechecks scope at observation insertion. Confirm cross-tenant, cross-site, cross-source and cross-asset negative cases remain covered across all writers.

### Alternate write paths
The D1 trigger is the commit-time enforcement boundary. Confirm direct SQL, ingestion Worker, batch and any future observation writer cannot bypass the trigger.

## 4. Staging impact inventory — not yet executed remotely

The aggregate inventory script is `apps/tenant-api/scripts/read-only-source-rights-impact-inventory.sql`. CI has exercised it against disposable local D1 only.

The checked-in `apps/tenant-api/wrangler.toml` intentionally has no D1 or Cloudflare Access bindings. The gateway configuration binds only to the private Tenant API Worker. A verified staging D1 identity and secure read-only query route are therefore not established by repository configuration.

Before remote staging execution:
1. Verify exact staging account, database name/ID and environment from authoritative Cloudflare configuration.
2. Confirm staging-only routing and a least-privilege read-only execution identity.
3. Record the inventory script commit and verified target identity.
4. Execute aggregate SELECT statements only; do not export tenant/source names, document bytes, raw telemetry, credentials or secrets.
5. Record execution time and aggregate results.
6. Do not access production, run migrations, write data, repair or backfill records.

The human reviewer authorization is limited to this read-only aggregate inventory against a verified staging D1 target. It does not establish that the target is configured or that the inventory has run.

## 5. Review outcome and next stage

**Current review decision:** Exact-head CI passed (4/4 jobs). Continue controlled non-production engineering only; independent technical review of current head remains pending.

**Completed:** implementation, exact-head CI (4/4 jobs), disposable local D1 inventory/test coverage. Earlier reviewer continuation approvals apply to earlier commits only.

**Pending:** genuine independent review of exact current head, staging D1 identity verification, secure read-only access, remote staging aggregate inventory, disposition of lifecycle policy and boundary/write-path findings, and final merge acceptance.

## 6. Operational boundary

No production database access, remote D1 migration, Worker deployment, PR merge, customer-data export, secret change or paid-resource change is authorized by this handoff.

A future merge decision requires the remaining review and staging gates to be satisfied. Any staging migration or deployment requires separate explicit operational authorization and a reviewed rollback/forward-recovery plan.


## Current-head validation refresh — 22 November 2026

An earlier PR head passed workflow run [45056756186](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/45056756186), with all four jobs successful. That result is historical and must not be attributed to a later head. The Tenant Worker job applied ordered migrations and completed the synthetic-fixture governance suite, including source-rights approval and observation commit guards. It remains disposable-local-D1 and repository CI evidence only; it does not establish a remote staging target or remote inventory execution.

The latest implementation also resolves exact accepted observation retries before current insert guards and rechecks for a concurrently committed matching observation after a failed insert batch. A deterministic mocked regression covers the concurrent retry case; live concurrent D1 stress testing is not claimed.

Prior independent review and continuation records target earlier commits and must not be treated as approval of the current head. A genuine independent reviewer must inspect the live PR head before final technical approval. PR #311 remains open and Draft; merge, deployment and remote migrations remain blocked pending the review and staging gates above.
