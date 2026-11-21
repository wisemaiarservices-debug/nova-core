# Source capability Tenant API — implementation contract (v1)

Status: design-only follow-up to PR #311. This document does not claim that capability management endpoints or an operator workflow exist.

## Current verified boundary

- `source_capabilities` and `source_capability_events` are governed by D1 migrations 0042–0052.
- Capability creation is a pending immutable version. D1 checks active tenant/site, verified site-bound source, source module, active creator membership, optional active same-site asset, and monotonically increasing version.
- A capability must be submitted before approval/rejection. Approval, rejection and revocation require an active tenant/site reviewer assignment, active reviewer membership, a reviewer different from the creator, and a valid lifecycle state.
- Event inserts drive status transitions; capability definitions and lifecycle events are immutable. Event request IDs are unique.
- The validator in `source-capability-contract.mjs` is structural/semantic validation only; it is not authorization or approval.
- `index.mjs` currently imports no capability lifecycle handler and has no capability routes. The lifecycle is currently a D1 schema boundary, not an exposed operational workflow.
- Source registration/mapping accepts tenant-scoped sources in some paths, but capability migrations 0043 and 0047 require `sources.site_id = capability.site_id`. This API must preserve that fail-closed behavior until product policy explicitly resolves tenant-scoped source semantics.

## Proposed API surface

All routes remain behind the existing authenticated private Tenant API gateway. Tenant identity is derived from the verified gateway identity and active membership; never accept a caller-supplied tenant ID as authority.

| Method | Route | Purpose |
|---|---|---|
| POST | `/internal/v1/tenants/{tenant}/sites/{site}/source-capabilities` | Create a pending immutable capability version |
| POST | `/internal/v1/tenants/{tenant}/sites/{site}/source-capabilities/{capability}/submit` | Append the creator's submitted event |
| POST | `/internal/v1/tenants/{tenant}/sites/{site}/source-capabilities/{capability}/review` | Reviewer decision: `approve` or `reject` |
| POST | `/internal/v1/tenants/{tenant}/sites/{site}/source-capabilities/{capability}/revoke` | Reviewer revocation of an approved capability |
| GET | `/internal/v1/tenants/{tenant}/sites/{site}/source-capabilities` | List scoped capabilities and current status |
| GET | `/internal/v1/tenants/{tenant}/sites/{site}/source-capabilities/{capability}` | Read one scoped capability and lifecycle timeline |

Reviewer assignment/revocation should reuse the existing site-scoped `tenant_source_reviewers` and `tenant_source_reviewer_events` governance unless a separately approved product policy requires a distinct capability-reviewer class. Do not create a parallel reviewer authority system by default.

## Authorization and scope rules

1. Resolve tenant from the verified identity/membership; compare the route tenant to that resolved tenant and return the existing non-enumerating `not_found` response on mismatch.
2. Require active tenant, active site and an active site read grant for every route.
3. Create and submit: tenant owner/admin only. The creator recorded in D1 must be the authenticated subject. Do not allow client-provided `created_by_subject`, status, tenant, site or timestamps.
4. Resolve source by exact `tenant_id + site_id + source_id`; require verified source and matching module. A tenant-scoped source (`site_id IS NULL`) remains unsupported for capability registration until migrations and product policy are deliberately changed together.
5. Optional asset must be active and match exact tenant/site. No caller-supplied asset scope can override this lookup.
6. Review/revoke: require an active site reviewer assignment and active tenant membership; creator self-review is forbidden. D1 remains the final authority for reviewer assignment, lifecycle and scope at commit time.
7. Read/list results must be scoped by exact tenant/site and resource grant; never list across sites by tenant alone.
8. Never accept browser-provided actor, tenant, reviewer identity or source verification status.

## Request and persistence contract

- Validate the capability body with `validateSourceCapabilityDraft(draft, resolvedSource)`. Map the validated draft to the existing immutable columns; store quality flags as canonical JSON.
- The API should generate the capability ID and immutable creator identity. Capability version must be checked against the full unique scope, but D1 migration 0043 remains authoritative against concurrent inserts.
- Capability creation and its request/idempotency record must commit atomically. Add a dedicated capability-request ledger (or prove an existing ledger provides equivalent scope, payload-hash, actor and replay guarantees) before exposing retries. A reused idempotency key with a different payload must return 409; an exact replay returns the original capability and current status.
- Submission, review and revocation must append only the matching event row. Do not update `source_capabilities.status` in application code; migration 0050 applies status transitions from the event. The database's unique event type and request ID constraints are authoritative.
- For an event retry, return the original event only when request identity, actor, capability scope, event type and payload digest match. Conflicting reuse returns 409. A small request ledger is preferred over treating a guessed request ID as sufficient idempotency.
- Evidence and data-rights references are identifiers, not proof that the referenced material is valid or legally sufficient. Require resolvable evidence metadata and an explicit rights review before approval policy is considered complete; do not infer rights from a non-empty string.
- Never let a capability API write observations. Observation ingestion remains a separate service and must pass migration 0055's commit-time capability and calibration guard.

## Lifecycle transitions

| Current state | Action | Actor | Next state |
|---|---|---|---|
| pending | submit | original creator | pending (submitted event recorded) |
| pending + submitted | approve | assigned independent reviewer | approved |
| pending + submitted | reject | assigned independent reviewer | rejected |
| approved | revoke | assigned independent reviewer | revoked |
| rejected/revoked | any further terminal decision | nobody | denied; create a new higher version if resubmission is warranted |

The API should return a conflict for invalid transitions. It must not invent a re-open or edit path for immutable definitions.

## Required adversarial tests before route exposure

- Unauthenticated, invalid gateway identity, inactive membership, inactive tenant/site, missing site grant and cross-tenant route mismatch.
- Source missing, unverified, wrong module, wrong site, wrong tenant, and tenant-scoped source rejected under current policy.
- Asset missing, inactive, wrong site and wrong tenant.
- Invalid body keys, malformed metric/unit/protocol/timezone, unsupported timezone, sampling boundary, quality flags, calibration profile reference, evidence/data-rights references, and validator/database parity.
- Creator cannot approve/reject/revoke; unassigned member cannot review; assigned reviewer with inactive membership cannot review; reviewer revoked immediately before decision cannot review.
- Submit before create, review before submit, duplicate submit, duplicate terminal event, rejected/revoked transition, and capability definition mutation/deletion.
- Same idempotency key + same payload replay; same key + different payload conflict; concurrent same-key create; concurrent competing review decisions; audit/event atomicity on rollback.
- Capability scope/list/detail queries never disclose another tenant/site's records.
- A capability cannot authorize ingestion until approved; revocation, source unverification, site deactivation, asset deactivation, calibration/mapping revocation and expiry continue to deny observations at D1 commit time.
- Route tests run through the actual Tenant Worker handler with disposable local D1 and the authenticated gateway test harness, not only isolated helper mocks.

## Delivery sequence

1. Implement request-ledger migration and D1 integration tests first.
2. Implement pure capability lifecycle persistence functions, using the validator and DB triggers; test them against disposable D1.
3. Add narrowly scoped route matching, request-body allowlists, authorization and non-enumerating errors to `index.mjs`.
4. Add Worker-level route tests for every authorization and idempotency case above.
5. Run the complete ordered migration suite and exact-head CI. Keep PR draft until a separate review verifies the API and tests.
6. Only after separate approval may a controlled staging plan be considered. This document authorizes no remote migration, Cloudflare change, deployment, merge or production data operation.

## Explicit non-goals

- No tenant-scoped source policy expansion.
- No frontend/UI claim or capability operator console claim.
- No live device, sensor or telemetry registration claim.
- No automatic AI approval, actuation or infrastructure action.
- No remote D1, Cloudflare, secret, customer-data or paid-resource changes.

## Draft-creation persistence implementation (0058)

A first bounded persistence slice is now present on the PR branch:

- Migration `0058_source_capability_creation_idempotency.sql` adds an immutable creation-request ledger scoped by tenant, site, actor and idempotency key.
- The D1 insert guard requires the exact pending capability draft, active tenant/site, active owner/admin membership, exact site read grant, and matching `source_capability.created` audit event.
- The ledger stores a lowercase SHA-256 request digest, capability ID, request ID and canonical response. Updates/deletes are denied.
- `source-capability-persistence.mjs` provides a persistence function that derives tenant/site/actor from trusted handler inputs, resolves a verified site-bound source, checks owner/admin and site grant, validates the draft, hashes canonical input, and atomically batches capability + audit + idempotency rows. Exact replay returns the stored response; same key with a different digest conflicts.
- `d1-source-capability-idempotency-tests.mjs` covers valid persistence rows, duplicate scoped keys, cross-tenant mismatch, missing matching audit, invalid digest, and immutable ledger behavior. CI now invokes this test after applying ordered migrations and seeding disposable local D1.

The function is not yet routed from `index.mjs`; it is not an exposed API. Submission/review/revocation endpoints, route-level authorization tests, and request/event idempotency remain future work. The code path must pass exact-head CI before it is treated as validated. No remote D1 or deployment action is authorized.
