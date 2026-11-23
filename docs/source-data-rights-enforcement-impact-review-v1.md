# Source data-rights enforcement impact review v1

**Review basis:** NOVA Core PR #311, exact implementation head `b1100a3081624471cc752ac11fcbbaefc5724f62`.  
**Exact-head CI:** [45050072553](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/45050072553) — 4/4 jobs passed.  
**Scope:** source implementation review and aggregate inventory executed by CI against disposable local D1. This is not a remote staging or production database inventory.

## 1. Current enforcement outcome

Migration 0064 closes the previously documented gap by enforcing the source data-rights/evidence chain at:
- capability approval (`source_capability_events`, `event_type='approved'`);
- new observation insertion (`observations`).

The guards require exact rights declaration and supporting evidence linkage, tenant/site/source/asset scope, current lifecycle state, valid effective windows, and explicit `measurement_ingestion` plus `storage` purposes. The observation insert guard rechecks the current rights/evidence state, so later revocation or withdrawal blocks new observations.

Historical observations are not rewritten or backfilled.

## 2. Exact-head validation

Run 45050072553 completed successfully:
- `api-tests`
- `research-raster-tests`
- `tenant-worker-tests`
- `Private tenant Worker package readiness (no deploy)`

The Tenant Worker tests applied ordered migrations to disposable local D1, seeded synthetic evidence/rights/capability fixtures, ran the aggregate inventory, and exercised lifecycle, calibration, gateway, observation and rights enforcement tests.

This confirms the tested repository behavior in disposable local D1 only. It does not establish remote staging or production behavior.

## 3. Disposable-local-D1 inventory result

The CI inventory is a test fixture diagnostic, not a customer-data inventory. Its synthetic counts must not be interpreted as remote tenant counts or evidence about any staging or production database.

No remote staging inventory has been executed. The checked-in Tenant API configuration intentionally has no D1 or Cloudflare Access bindings, and the gateway configuration contains only the private Tenant API Service Binding. Therefore a verified staging D1 identity and secure query route remain prerequisites.

## 4. Confirmed implementation properties

- Rights declaration reference resolves within exact tenant/site/source scope.
- Nullable asset scope is compared with NULL-safe equality.
- Supporting evidence ID and digest are bound to the immutable document and declaration.
- Capability evidence reference matches the supporting evidence document ID.
- Both required purposes, `measurement_ingestion` and `storage`, are explicit.
- Rights and evidence lifecycle/effective-window checks are repeated at observation insertion.
- Revocation/withdrawal blocks future observation inserts.
- Existing observation rows are not rewritten.

## 5. Review questions and residual risks

1. **Lifecycle re-approval:** Unique event-type constraints mean revoked evidence or rights declarations cannot be re-verified/re-approved in place. A replacement record/workflow is required unless policy changes.
2. **Latest-event ordering:** Lifecycle checks use append-only event rows ordered by rowid. Confirm the append-only assumption and writer constraints.
3. **Effective-date boundaries:** Timestamp comparisons use `julianday()`. Current regression coverage includes whole-second effective-from acceptance and existing expired-rights rejection; additional exact boundary cases would strengthen assurance.
4. **Alternate write paths:** Confirm all supported observation insertion paths remain subject to the database guard.
5. **Historical records:** Existing observations remain unchanged; the new guard is prospective.

These are explicit review questions, not claims that remote production behavior has been tested.

## 6. Staging impact inventory requirements

Before remote execution:
- verify the exact staging account, database name/ID and environment from authoritative configuration;
- confirm staging-only routing and least-privilege read-only access;
- capture the inventory script commit and target identity;
- run aggregate SELECT queries only;
- record execution time and aggregate output;
- do not export tenant/source identifiers, document bytes, raw telemetry, credentials or secrets;
- do not access production or perform writes, migrations, repairs or backfills.

The reviewer previously authorized a read-only aggregate inventory only against a verified staging D1 target. Authorization is not evidence of execution.

## 7. Current disposition

**Implementation and exact-head CI:** accepted for continued controlled engineering.  
**Reviewer decision:** approved to continue on the current head.  
**Remote staging impact inventory:** pending verified staging D1 identity and secure read-only access.  
**Merge and deployment:** not authorized by this impact review.

This document is a source-level impact assessment and safety handoff, not a legal determination, penetration test, production certification or authorization to process customer data.


## Current-head validation refresh — 22 November 2026

The current PR head `b1100a3081624471cc752ac11fcbbaefc5724f62` passed workflow run [45050072553](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/45050072553), with all four jobs successful. This run validates the current documentation/inventory correction head. It remains disposable-local-D1 and repository CI evidence only; it does not establish a remote staging target or remote inventory execution.
