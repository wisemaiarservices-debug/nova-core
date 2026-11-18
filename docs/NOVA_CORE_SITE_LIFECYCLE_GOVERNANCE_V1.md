# NOVA Core Site Lifecycle Governance V1 — Design

Status: design-only; no runtime route or migration is introduced by this document.

## Purpose

A site may be deactivated while an assessment operation is reserved or running. Assessment completion already rechecks that the exact site is active at the final database write boundary. This design adds a governed, auditable way to change site lifecycle state so that this invariant can be exercised through the real HTTP workflow.

The lifecycle mutation must fail closed. A site status change must not be implemented as an unguarded generic resource update.

## Repository observations

- The tenant API currently exposes site listing and site detail, but no dedicated site lifecycle mutation or lifecycle-event route.
- Site creation has a separate immutable tenant_site_events record whose event type is constrained to created. Do not overload that creation ledger with deactivation/reactivation events.
- Existing tenant lifecycle operations demonstrate the owner-authorized event-plus-state-change pattern, but site lifecycle needs its own exact site-scoped authorization and database guards.
- Assessment completion SQL already requires the observation's tenant and site to remain active at insert time. A site deactivation committed before completion should therefore prevent a passed/failed assessment from being inserted and produce the operation's durable not_assessed result through the completion service.


## Confirmed schema and consumer audit (2026-11-18)

The current sites table is created in apps/api/migrations/0001_initial.sql. Its status CHECK permits exactly:
- unconfigured (the column default);
- active;
- inactive;
- archived.

The controlled site-creation service (apps/tenant-api/src/site-creation.mjs) explicitly inserts new governed sites as active. Its retry returns the site's current status, not a historical snapshot. This means lifecycle work must not change creation idempotency semantics.

Migration 0002_tenant_isolation.sql adds site/tenant integrity guards:
- site insert requires an active tenant;
- tenant_id changes require an active tenant;
- every site update requires the owning tenant to remain active.
These guards do not currently authorize or audit a status transition.

The existing tenant_site_events table from migration 0027 is strictly event_type='created' and append-only. It has no status-transition representation and must remain unchanged.

Confirmed tenant-API consumers in apps/tenant-api/src/index.mjs include:
- site resource detail reads status without requiring active status, supporting controlled visibility of the exact site record;
- site listing returns active sites only;
- site observation feed requires active site;
- asset reads and grantable-asset resolution require active site and active asset;
- site-bound source reads/resolution require active site; global sources remain possible;
- observation reads and grantable-observation resolution require active site;
- site grant mutation requires active site;
- tenant asset/source/observation grant creation rechecks active site for site-bound resources.

Consequences for the lifecycle contract:
- The only initial supported lifecycle transitions should be active -> inactive (deactivate) and inactive -> active (reactivate).
- archived remains terminal and must not be reactivated by this route.
- unconfigured is not a lifecycle synonym for inactive. It is not accepted by deactivate/reactivate until a separate explicit policy and tests establish its meaning.
- Deactivation should leave status='inactive'; do not introduce a new value or modify the CHECK.
- The active-site predicates already present in reads, grants and the assessment completion write should naturally fail closed after deactivation. New integration tests must assert these effects, not assume all reads are blocked: exact site detail read currently selects by tenant/id and does not filter status.
- Reactivation restores only site-level eligibility. It must not reactivate assets, verify sources, restore grants or make stale calibration/mapping/policy evidence valid.

This audit is scoped to the inspected initial/tenant-isolation/site-creation migrations and tenant-api index/service files. Before runtime implementation, repeat the search across all migrations, Worker packages and NOVA OS callers for direct sites.status writes and status-dependent queries; no unreviewed generic update path may bypass the new event guard.

## Proposed HTTP contract

Private Worker routes, forwarded only by the authenticated gateway:

- POST /internal/v1/tenants/{tenant_id}/sites/{site_id}/lifecycle-actions
- GET /internal/v1/tenants/{tenant_id}/sites/{site_id}/lifecycle-events

Gateway public paths must use the existing /api/v1/... prefix and exact method/path allowlists. Do not introduce wildcard forwarding.

Mutation request accepts only:
- action: deactivate or reactivate
- reason: trimmed non-empty text, bounded to 1,000 characters

No caller-supplied tenant, site, actor, previous status, new status, timestamp, or event ID is trusted. Actor comes from the verified gateway envelope. Time and event identifiers are server-generated.

## Authorization

For every mutation and event read, resolve the exact tenant/site pair server-side and require:
- tenant is active;
- actor has active membership in that tenant;
- actor role is tenant_owner or tenant_admin;
- actor has an exact active site read grant;
- site belongs to the supplied tenant;
- lifecycle transition is valid.

Recheck these predicates in the database write statement/trigger, not only in route code. A revoked membership or site grant between route authorization and mutation must prevent the state change.

The route must return a non-disclosing not-found/authorization response for cross-tenant, inactive, or unauthorized site references.

## State and audit model

Before implementing a migration, inspect and document the current sites.status constraints and every consumer of site status. Preserve the established status vocabulary and terminal-state rules; do not silently add an incompatible status value.

Create a distinct tenant_site_lifecycle_events append-only ledger with:
- event ID;
- tenant ID and site ID;
- actor subject;
- event type (deactivated or reactivated);
- previous and new site status;
- bounded reason;
- unique transport request ID;
- server timestamp.

Use exact tenant/site composite foreign keys where supported by the existing schema. Reject event update/delete. Guard event inserts against current tenant, site, active membership, owner/admin role, exact site grant and valid transition. Guard state mutation against a matching event and exact prior status. The event and state transition must commit atomically; a losing concurrent transition returns conflict and leaves no orphan event.

Deactivation is not deletion. It must preserve historical observations, evidence, assets, calibration, mappings, policies and assessment history. Reactivation must be explicit and audited; it must not automatically reactivate sources, assets, grants, memberships, calibrations, mappings or policies.

## Assessment completion invariant

The final assessment INSERT remains the authority boundary:
- it must recheck exact tenant/site/observation relationship and site.status='active' in the same guarded write;
- if deactivation wins before completion, no passed/failed assessment is inserted;
- operation completion records not_assessed with a stable reason such as site_inactive_at_completion;
- if assessment completion commits first, a later site deactivation does not rewrite the historical assessment;
- a lost HTTP response must replay the original immutable operation result.

Do not rely on a preliminary route-level site lookup as the race guard.

## Required integration tests

Use the local gateway → private Worker → disposable D1 setup:
1. Create a site with a valid owner and exact read grant.
2. Deactivate through the public gateway; verify exact event and state.
3. Reject duplicate deactivation and invalid transition.
4. Reject a non-admin member, cross-tenant site ID, inactive membership and revoked site grant.
5. Attempt direct SQL status update without the matching event and assert database rejection.
6. Race two lifecycle transitions; one wins, one conflicts, with no orphan event.
7. Reserve and claim an assessment operation, deactivate its site through HTTP, then complete with the valid lease; expect durable not_assessed and no passed/failed assessment row.
8. Attempt completion after reactivation only when all independent evidence gates are still valid; reactivation alone must not restore evidence.
9. Verify historical observations, evidence and assessments remain unchanged.
10. Verify exact idempotent retry behavior and append-only event history.

Test both orders of the race (deactivation before completion and completion before deactivation) using actual D1/Worker execution where deterministic coordination is available. A mocked meta.changes result is not sufficient.

## Release gates

- Exact-head CI passes API/security, ordered disposable D1 migration/Worker integration, and research tests.
- Static audit confirms no generic site update path bypasses lifecycle governance.
- Gateway and private Worker route allowlists are exact.
- NOVA OS surfaces the lifecycle state and audit history without implying that deactivation deletes data.
- Staging validation, key/secret approval and deployment authorization remain separate gates.

## Explicit non-goals

No production or staging mutation, migration, deployment, tenant/site provisioning, customer data, secrets, paid service, automatic evidence restoration, or scientific-validity claim is authorized by this design.
