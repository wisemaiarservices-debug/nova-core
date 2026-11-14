# NOVA Core tenant provisioning contract — v1

## Status

Phase 1 is implemented as a draft migration and SQLite contract tests. The
migration adds an append-only membership-event ledger, validates event
pre-state, requires a matching event for role/status updates, and prevents
demotion or revocation of the last active owner. The private Tenant API and
Access gateway still do not expose general tenant or membership provisioning.
No migration has been applied to a live database; no tenant, membership, grant,
secret, binding, Cloudflare resource, route, or deployment has been created.

## Existing trust boundary

The supported human request path is:

1. Cloudflare Access protects the public gateway hostname.
2. The gateway verifies a human Access JWT against the configured issuer and
   audience, rejects service-token identities, and derives the stable subject
   from the verified `sub` claim.
3. The gateway constructs a minimal identity envelope and signs the exact
   method, path, subject, issuer, audience, issue time, and request ID with
   HMAC-SHA256.
4. The private Tenant API verifies that signature, freshness, and one-time
   request ID before loading tenant membership and exact resource grants.
5. D1 queries are parameterized and tenant-scoped.

Provisioning must reuse this boundary. It must not accept caller-supplied
identity headers, role claims, tenant membership state, actor IDs, or an
arbitrary upstream URL.

## Tenant creation and initial owner

Tenant creation is a privileged provisioning operation, not an ordinary
tenant-member action.

- A dedicated, explicit provisioning allowlist must be configured
  independently on the gateway and private Worker. Empty or malformed
  configuration denies all provisioning.
- The allowlist contains exact verified Access `sub` values, not email-domain
  wildcards, caller-provided emails, or role claims.
- The tenant creator must be the authenticated allowlisted principal. The
  initial `tenant_owner` membership subject is derived from that same verified
  principal; the request body cannot nominate another user.
- There is no first-user auto-claim, open self-service tenant creation,
  email-domain bootstrap, default tenant, or fallback owner.
- Tenant row, initial owner membership, tenant-level exact grants, and the
  first immutable membership audit event must commit atomically. Partial
  tenant creation is not acceptable.
- Provisioning is idempotent only for a caller-supplied idempotency key bound
  to the exact canonical request and verified actor. Reuse with different
  content must conflict.
- Tenant IDs are generated or strictly validated server-side; tenant status
  always starts as `active`. No request may create a suspended/archived
  tenant and attach an owner implicitly.

## Membership lifecycle

The v1 membership API should support explicit invite/activate, role change,
suspend, revoke, and reactivate operations. It must not support changing the
subject or tenant scope of an existing membership; revoke and create a new
membership instead.

- Only an active `tenant_owner` may manage memberships in v1. An admin role
  cannot create another owner, promote itself, or bypass owner approval.
- The target subject must be a non-empty stable identity identifier obtained
  from a separately verified identity directory/invitation flow. Do not
  accept a display name as identity.
- The acting owner cannot revoke or demote the last active owner. A transfer
  operation, if added later, must atomically install the successor before
  removing the prior owner.
- Duplicate active memberships and ambiguous membership rows fail closed.
- Each state change is an atomic transaction that updates membership state
  and appends one immutable event with actor, subject, prior/new role,
  prior/new status, reason, request ID, and UTC timestamp.
- Event rows are append-only; ordinary clients cannot insert, update, or
  delete them. Event history is tenant-scoped and readable only by authorized
  tenant owners/admins.
- Tenant suspension blocks membership activation and all tenant-owned writes.
  Suspension/archival itself requires a separate owner-only governed operation.

## Database requirements before endpoint implementation

Migration 0002 defines `tenants`, `tenant_memberships`, and exact
`tenant_resource_grants`; migration 0004 makes membership identity scope
immutable. Draft migration `0016_tenant_membership_events.sql` now adds a
constrained tenant-scoped event ledger, foreign keys, unique request IDs,
append-only UPDATE/DELETE guards, event pre-state checks, matching-event
requirements for role/status updates, and last-active-owner protection.
SQLite migration tests cover these invariants. The CI pipeline also applies
ordered migrations to disposable local D1 and exercises the Worker boundary.

Remaining requirements before endpoint implementation:

1. Add unique/idempotency storage for tenant creation requests, scoped to the
   verified actor and canonical request digest.
2. Preserve immutable `tenant_id` and `subject` membership scope.
3. Ensure every event write is made only by the private Tenant API after
   authenticated identity and owner authorization; the gateway must not expose
   direct database access.
4. Extend adversarial and disposable D1 integration tests to cover membership
   create/transition batches and rollback behavior.
5. Review the event ledger retention and tenant deletion restrictions.

## API contract (proposed; not yet implemented)

- `POST /api/v1/tenants`: allowlisted provisioning principal creates a tenant
  and is atomically assigned as its initial owner.
- `POST /api/v1/tenants/{tenant}/memberships`: active owner creates a
  membership for a verified stable subject with a bounded role.
- `POST /api/v1/tenants/{tenant}/memberships/{membership}/transition`:
  active owner performs one explicit legal lifecycle transition.
- `GET /api/v1/tenants/{tenant}/membership-events`: owner/admin read of
  append-only tenant membership history.

The public gateway must map only these exact routes to fixed private paths.
POST bodies must be bounded JSON; query strings, unknown fields, wildcard
grants, arbitrary role names, and caller-supplied actor identities are rejected.
The private Worker rechecks all authorization and tenant state from D1; gateway
authentication alone never grants tenant access.

## Required adversarial tests

- Unauthenticated, invalid, expired, replayed, or forged gateway envelopes.
- Non-allowlisted tenant creation; empty/malformed allowlist.
- Attempt to nominate another initial owner or supply actor identity.
- Idempotent exact replay and conflicting idempotency-key reuse.
- Cross-tenant membership ID, unknown tenant, suspended tenant, duplicate
  membership, unknown role/status, and malformed subject.
- Admin/operator/viewer attempting membership management.
- Self-promotion, owner self-revocation, and last-active-owner removal.
- Illegal state transitions and duplicate transition requests.
- Audit-event mutation/deletion, missing event, mismatched event actor/subject,
  and transaction rollback on any failed write.
- Tenant isolation and indistinguishable not-found behavior for inaccessible
  membership/event resources.

## Release gates

This feature remains blocked until the exact-head unit, migration, gateway,
and disposable D1 + Service Binding integration tests pass; a security review
confirms that the provisioning allowlist cannot be modified by a tenant
request; and the user explicitly approves production migration/deployment.
Migration 0016 exists only in this draft branch and has not been applied to
any live database. No secret, Access policy, D1 binding, Worker route, or
deployment is authorized by this design.
