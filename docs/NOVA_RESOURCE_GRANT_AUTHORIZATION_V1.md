# NOVA Core resource-level authorization contract v1

Status: design contract for the next implementation increment. This document does not enable an API route or grant access.

## 1. Scope

The existing tenant resource-grant registry supports exact `asset`, `source` and `observation` resource types, but the current owner/admin mutation endpoint is site-only and its audit table is site-specific. Do not treat the registry's accepted type values as proof that resource-level grant mutation is implemented.

This contract extends the current explicit site-grant model to:
- `asset`
- `source`
- `observation`

The existing site-grant route remains compatible. No wildcard, prefix, collection, tenant-wide inheritance or implicit parent-to-child grant is introduced.

## 2. Authentication and actor

All mutations pass through the existing Cloudflare Access gateway and signed gateway-to-private-Worker envelope. The private Worker derives the actor only from the verified envelope subject and loads the actor's active membership and tenant status from D1.

Never accept actor subject, role, tenant ID, membership ID, grant ID, or reviewer identity from the request body. Reject unknown body keys. Tenant and resource IDs in the URL/body are selectors only and must be checked against persisted ownership.

## 3. Authorization policy

- Only an active tenant owner or tenant admin may manage resource grants.
- Owners may grant/revoke `read`, `create`, `update`, `delete`, and `ingest`.
- Admins may grant/revoke `read`, `create`, `update`, and `ingest`; `delete` remains owner-only.
- `manage_members` is not a resource permission and must be rejected.
- A grant target must be an existing active membership in the same tenant.
- A revoked/inactive membership may have stale grants explicitly revoked, but must never receive a new grant.
- A member's inactive/revoked membership status blocks access regardless of any surviving grant rows.
- No user may grant access to a resource in another tenant.

## 4. Exact resource scope

Before a mutation, resolve the resource using a fixed, server-owned SQL statement selected from an allowlisted resource type. Never interpolate caller-provided table or column names.

Require exactly one row and verify:
- resource ID equals the requested ID;
- resource tenant ID equals the tenant in the route;
- asset and observation parent site IDs resolve to a site in the same tenant;
- source site ID, when non-null, resolves to a site in the same tenant;
- observation source and optional asset both belong to the same tenant and site as the observation.

A missing, duplicate, archived/inactive, unassigned or cross-tenant resource fails closed. Do not infer source/site relationships from names, external references, metadata or provider payloads.

A resource grant applies only to the exact `(tenant_id, subject, resource_type, resource_id, action)` tuple. A site grant does not automatically grant child asset/source/observation access, and a child grant does not imply site-wide access.

## 5. Mutation and audit transaction

Use a new generic append-only `tenant_resource_grant_events` table. Each event records:
- tenant ID;
- grant ID;
- subject;
- resource type and resource ID;
- action;
- event type (`granted` or `revoked`);
- verified actor subject;
- bounded non-empty reason;
- unique request ID and server timestamp.

The grant row mutation and corresponding event insert must be performed in one D1 batch. A failed second statement must cause the endpoint to return conflict and must not be reported as a successful transition. Database triggers must verify that a grant event corresponds to the resulting grant state and reject UPDATE/DELETE of event rows.

Enforce unique exact grants in the database. Duplicate grant attempts return conflict. Revocation must delete only the exact tenant/subject/type/resource/action tuple and must append the matching event only if exactly one row was removed.

## 6. Read authorization

Resource reads must require:
1. active tenant;
2. active membership for the verified subject;
3. role permission for the requested action;
4. exact matching resource grant;
5. exact resource tenant and parent-site consistency.

Do not substitute a site grant for an exact resource grant. Do not use an unscoped resource lookup followed by a tenant check when a tenant-scoped query is available.

## 7. Required tests before enabling the route

### Positive cases
- Owner grants and revokes each allowed action for each resource type.
- Admin grants/revokes read/create/update/ingest but cannot grant/revoke delete.
- Every event is appended atomically and contains the authenticated actor, exact resource tuple and request ID.
- A valid resource belonging to the same tenant and site is accepted.

### Negative and isolation cases
- Cross-tenant resource, site, asset, source, observation, or target membership.
- Observation whose source or optional asset has a mismatched tenant/site.
- Source with a site in another tenant.
- Unknown resource type, unknown action, wildcard ID, malformed ID, extra body key, blank/oversized reason.
- Inactive/archived/unassigned resource.
- Inactive/revoked target membership on grant; stale-grant cleanup on revoke.
- Duplicate grant, missing revoke target, ambiguous duplicate resource lookup.
- Admin delete permission; any `manage_members` resource permission.
- Caller-supplied actor/role/tenant/grant identity.
- Audit insert failure, grant mutation failure, duplicate request ID and event-state mismatch.
- UPDATE/DELETE attempts against audit events.
- A grant for one child resource does not authorize a sibling or parent resource.
- A site grant does not authorize a child resource absent its own exact grant.
- Suspended/revoked membership denies reads even when an old grant row remains.

Run ordered migrations 0001–0020 against disposable local D1 and exercise gateway → private Worker → D1 integration before considering the route ready.

## 8. Rollout boundary

This is a contract only. The generic resource-grant endpoint, generic audit migration, gateway route, read-path enforcement and their tests remain unimplemented until separately validated. No production migration, grant, tenant, secret, Access policy or deployment is authorized by this document.
