# Source data-rights enforcement and cutover plan

**Status:** The original design gap described below has been implemented by migration 0064. This document is retained as design history and requirements traceability; it is not the current implementation status or a deployment authorization.

**Current implementation:** NOVA Core PR #311, head `b1100a3081624471cc752ac11fcbbaefc5724f62`.  
**Exact-head CI:** [45050072553](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/45050072553), 4/4 jobs passed.

## 1. Historical finding — superseded

At the earlier source revision `d2f2f146670820a37efb6933647a89875f94657d`, migrations 0060–0062 provided evidence and rights registries, but those registries were not yet enforcement dependencies for capability approval or observation insertion.

**That gap was addressed in migration 0064:** it adds database-level guards at capability approval and observation insertion. Do not use the historical finding above to describe the current PR #311 head.

## 2. Implemented reference and authorization contract

The current implementation requires:
- `data_rights_ref` to resolve to the exact rights declaration in the capability's tenant/site/source scope.
- Nullable asset scope to match using NULL-safe equality.
- The rights lifecycle's latest event to be approved and the effective window to be valid.
- Supporting evidence ID, SHA-256 digest and scope to match the immutable evidence document.
- The evidence lifecycle's latest event to be verified and its effective window to be valid.
- Both `measurement_ingestion` and `storage` to be explicitly permitted.
- Capability `evidence_ref` to match the supporting evidence document ID.

Analytics and model-training permissions are not inferred from ingestion or storage. Rights and evidence are rechecked at observation insertion, so subsequent revocation or withdrawal blocks new observations. Historical observations remain unchanged.

## 3. Current enforcement points

### Capability approval

Migration 0064 guards insertion of an `approved` event in `source_capability_events`. It resolves and validates the rights declaration, exact scope, current rights state, evidence ID/digest/scope, evidence verification state, effective windows and required purposes.

### Observation commit

Migration 0064 independently guards new observation insertion, rechecking the current rights/evidence chain against the exact capability and observation scope. The existing migration 0055 capability/calibration guard remains in place.

## 4. Current validation evidence

Exact-head workflow [45050072553](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/45050072553) passed:
- API tests
- Research/raster tests
- Tenant Worker tests
- Private Tenant Worker package readiness without deployment

Ordered migrations and governance regression tests ran against disposable local D1 with synthetic fixtures. This evidence does not establish remote staging or production behavior.

## 5. Remaining policy and verification questions

- Lifecycle event uniqueness prevents re-verifying/re-approving the same evidence or rights record after revocation; replacement records/workflow are required unless policy changes.
- Latest-event checks rely on append-only lifecycle rows ordered by rowid.
- Effective-window tests should be expanded around exact start/end boundaries and timestamp formats.
- All supported observation writers must remain subject to the D1 insertion guard.
- The distinction between historical observations and prospective enforcement must remain explicit.

These are review and product-policy questions; they do not imply that the implemented guard is absent.

## 6. Impact inventory and cutover constraints

The read-only aggregate inventory at `apps/tenant-api/scripts/read-only-source-rights-impact-inventory.sql` has been exercised in CI against disposable local D1. No remote staging inventory has been run.

The Tenant API Worker configuration has no D1 or Cloudflare Access bindings. A verified staging database target and secure read-only query path must be established before the separately authorized staging inventory can run.

For any staging inventory:
- Verify the exact staging database identity from authoritative configuration.
- Use a staging-only, read-only execution path.
- Record script commit, target identity, execution time and aggregate output.
- Do not export tenant/source names, document bytes, raw telemetry, credentials or secrets.
- Do not access production, write data, migrate, repair or backfill records.

## 7. Rollout boundary

The human reviewer approved continuation to the next controlled engineering stage on the current PR head. That approval does not authorize merge, remote migration, Worker deployment or production operations.

**Current disposition:** implementation and exact-head automated validation accepted for continued non-production work; remote staging inventory pending verified target; merge and deployment remain gated by final review and separate operational authorization.


## Current-head validation refresh — 22 November 2026

The current PR head `b1100a3081624471cc752ac11fcbbaefc5724f62` passed workflow run [45050072553](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/45050072553), with all four jobs successful. This run validates the current documentation/inventory correction head. It remains disposable-local-D1 and repository CI evidence only; it does not establish a remote staging target or remote inventory execution.
