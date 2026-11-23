# Source rights cutover implementation plan v1

**Status:** Implementation and exact-head CI complete; reviewer approved continuation to the next controlled engineering stage. Remote staging inventory and any deployment remain gated.

**Current PR:** [NOVA Core #311](https://github.com/wisemaiarservices-debug/nova-core/pull/311)  
**Reviewed implementation head:** `b1100a3081624471cc752ac11fcbbaefc5724f62`  
**Exact-head CI:** [45050072553](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/45050072553) — 4/4 jobs passed.

## 1. Verified implementation

- Migration 0055 enforces source capability and calibration requirements at observation insertion.
- Migrations 0060–0063 provide evidence and data-rights registries, lifecycle controls, idempotency and effective-window protections.
- Migration 0064 adds rights/evidence checks at capability approval and observation insertion.
- Rights and evidence scope, lifecycle state, effective windows, exact supporting evidence and required `measurement_ingestion` plus `storage` purposes are checked.
- Persistence resolves scoped evidence digests and distinguishes exact idempotent retries from conflicting payloads.
- Timestamp comparisons in migrations 0060, 0062, 0063 and 0064 use SQLite `julianday()` comparisons to avoid lexical ordering errors between whole-second and millisecond UTC timestamps.
- Historical observations are not rewritten or backfilled. New insert guards apply prospectively.

## 2. Exact-head validation

Run 45050072553 passed all four jobs:
- `api-tests`
- `research-raster-tests`
- `tenant-worker-tests`
- `Private tenant Worker package readiness (no deploy)`

The Tenant Worker job applied ordered migrations to disposable local D1 and exercised source evidence, rights, capability lifecycle, calibration, gateway and observation guards. The package-readiness job bundled Workers without deploying them.

This is repository-level and disposable-local-D1 evidence. It does not prove remote staging or production behavior.

## 3. Enforced database boundaries

Migration 0064 adds two independent `BEFORE INSERT` guards:

1. **Capability approval:** resolves `data_rights_ref` to the exact rights declaration and checks tenant/site/source and NULL-safe asset scope; approved rights state and effective window; exact supporting evidence ID, digest and scope; capability evidence reference; verified evidence state and effective window; and explicit `measurement_ingestion` plus `storage` purposes.
2. **Observation insertion:** rechecks the same rights/evidence chain against the observation's exact capability scope at insert time. Rights revocation or evidence withdrawal blocks future observations without rewriting historical rows.

Analytics and model-training permissions are not inferred from ingestion or storage. Existing migration 0055 handling retains precedence for missing capability identity and capability scope mismatch.

## 4. Regression and fixture coverage

CI uses synthetic fixtures and disposable local D1. The suite covers positive exact-scope approval/insertion, missing storage purpose, unresolved rights reference, mismatched supporting evidence, rights revocation, evidence revocation, capability lifecycle, calibration, quality flags, idempotency and overlapping capability rejection.

The latest timestamp regression includes acceptance of a whole-second `effective_from` value. An attempted additional expired-rights fixture was removed after its setup failed on an unrelated reviewer/fixture constraint; it is not counted as successful new boundary coverage. Existing expired-rights rejection coverage remains.

## 5. Reviewer decision and remaining technical checks

The human reviewer recorded **APPROVED TO CONTINUE** against the exact implementation head `b1100a3081624471cc752ac11fcbbaefc5724f62`. This authorizes controlled non-production preparation and verification work. It is not a production approval or merge authorization.

The review record identifies these matters for explicit assessment:
- Lifecycle policy: unique per-record event-type constraints mean revoked evidence or rights declarations cannot simply be re-verified/re-approved in place; replacement records/workflow are required unless policy changes.
- Latest-event ordering uses append-only lifecycle rows ordered by rowid.
- Effective-date boundary coverage includes whole-second acceptance and existing expired-rights rejection, but is not exhaustive.
- Alternate observation write paths must remain covered by the D1 trigger.
- Asset scope is checked with NULL-safe equality.

## 6. Read-only staging impact assessment

The aggregate-only inventory is `apps/tenant-api/scripts/read-only-source-rights-impact-inventory.sql`. CI executed it against disposable local D1 only.

The checked-in Tenant API configuration intentionally has no D1 or Cloudflare Access bindings. The gateway has a private Service Binding to the Tenant API but does not establish a staging D1 target. Therefore no verified remote staging D1 identity or authorized query path is currently available.

Before a remote staging run:
1. Verify exact staging account, database name/ID, environment and data classification from authoritative Cloudflare configuration.
2. Confirm a staging-only execution path and least-privilege read-only access.
3. Capture the inventory script commit and target identity before execution.
4. Execute only aggregate SELECT queries; do not export tenant/source identifiers, document bytes, raw telemetry, credentials or secrets.
5. Record execution time and aggregate results, then review any affected legacy records.
6. Do not use a production target, apply migrations, repair, backfill or modify records.

The prior reviewer authorization is limited to this read-only aggregate inventory against a verified staging D1 target. It does not prove that the target exists or that the inventory has been executed.

## 7. Controlled rollout sequence

1. Fixture conversion, migrations and disposable local D1 validation — complete.
2. Exact-head CI — complete, 4/4 passed.
3. Human reviewer approval to continue — recorded on exact head.
4. Documentation refresh and staging readiness verification — in progress.
5. Verify staging D1 identity and secure read-only query path — pending.
6. Execute authorized aggregate-only staging inventory — pending.
7. Resolve any legacy-record policy questions and refresh final handover.
8. Obtain final acceptance before merge; obtain separate staging migration/deployment authorization before any remote operation.

## 8. Explicit non-actions

No remote D1 migration, remote staging inventory, Worker deployment, PR merge, secret change, customer notification or paid-resource change has been performed by this stage. No production readiness is claimed.


## Current-head validation refresh — 22 November 2026

The current PR head `b1100a3081624471cc752ac11fcbbaefc5724f62` passed workflow run [45050072553](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/45050072553), with all four jobs successful. This run validates the current documentation/inventory correction head. It remains disposable-local-D1 and repository CI evidence only; it does not establish a remote staging target or remote inventory execution.
