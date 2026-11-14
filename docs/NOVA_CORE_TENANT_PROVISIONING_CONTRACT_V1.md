# NOVA Core tenant provisioning and membership contract — v1

## Status and release boundary

The draft branch implements:
- Controlled tenant creation with dual exact-subject provisioning allowlists.
- Atomic initial-owner assignment, tenant grants, append-only audit event and idempotency record.
- Owner-issued, possession-based membership invitations with seven-day expiry, one-time token display, authenticated acceptance and owner revocation.
- Audited membership role change, suspension, revocation and reactivation actions.
- Owner/admin-only bounded membership, invitation and site-grant audit history.
- Exact site-scoped grant assignment/revocation with tenant, active site and active member validation.

The private Worker, gateway, migrations and integration tests exist only in this draft branch. Site-grant events are also append-only and included in the bounded tenant audit timeline. Migrations have been applied only to disposable local D1 in CI. No live D1 migration, production allowlist, Access policy, secret, binding, tenant, membership, grant or deployment has been created or changed.

## Identity and trust boundary

1. Cloudflare Access protects the public gateway hostname.
2. The gateway verifies the Access JWT against configured issuer and audience and derives the stable subject from its verified `sub` claim.
3. The gateway constructs a minimal identity envelope and signs the exact method, path, subject, issuer, audience, issue time and request ID with HMAC-SHA256.
4. The private Tenant API verifies the signature, freshness and one-time request ID before checking tenant membership and role.
5. D1 queries are parameterized and tenant-scoped. Actor identity and role are always derived from the verified envelope and persisted membership, never from the JSON body.

No route accepts caller-supplied actor IDs, owner identities, role claims, tenant membership state, arbitrary upstream URLs or identity headers as authority.

## Tenant creation and initial owner

- A dedicated exact-subject provisioning allowlist must be configured independently on the gateway and private Worker. Empty or malformed configuration denies provisioning.
- The allowlist contains exact verified Access `sub` values, not email-domain wildcards or caller-provided emails.
- The initial `tenant_owner` is the authenticated allowlisted principal. The request body cannot nominate another user.
- No first-user auto-claim, open self-service creation, email-domain bootstrap, default tenant or fallback owner exists.
- Tenant row, initial owner membership, exact tenant-level grants, first immutable membership event and idempotency record commit atomically.
- Idempotency keys are bound to the verified actor and canonical request digest; conflicting reuse fails.
- Tenant status begins active. The request cannot create an archived or suspended tenant.

## Membership invitation lifecycle

### Issue
`POST /api/v1/tenants/{tenant}/membership-invitations`

Only an active tenant owner may issue an invitation. Roles are limited to `tenant_admin`, `operator`, `analyst` and `viewer`; owner and service identities cannot be invited through this route. A 256-bit random token is generated; only its SHA-256 digest is stored. The raw token is returned once and must be shared manually through a trusted out-of-band channel. No email delivery or email-address verification is claimed.

### Accept
`POST /api/v1/tenants/{tenant}/membership-invitations/{invitation}/accept`

The invitee must authenticate through Cloudflare Access. Acceptance binds the new membership to the verified Access `sub`, not to a subject in the body. The token is one-time, expires after seven days, and duplicate existing memberships are rejected. Membership, exact tenant-level read grant and append-only membership/invitation events are written in one D1 batch.

### Revoke
`POST /api/v1/tenants/{tenant}/membership-invitations/{invitation}/revoke`

Only an active tenant owner may revoke a pending invitation. The invitation and event history cannot be deleted or rewritten.

## Membership lifecycle actions

`POST /api/v1/tenants/{tenant}/membership-actions`

Body fields are exactly `membership_id`, `action`, `reason`, and `role` only for `change_role`. Unknown keys, invalid roles, malformed IDs, blank or oversized reasons are rejected. The membership subject and tenant scope are looked up from D1; they cannot be changed.

| Action | Tenant owner | Tenant admin |
|---|---|---|
| `change_role` | Yes; active target only, roles tenant_admin/operator/analyst/viewer | No |
| `suspend` | Yes | Only operator/analyst/viewer targets |
| `revoke` | Yes | Only operator/analyst/viewer targets |
| `reactivate` | Yes, inactive target only | Only operator/analyst/viewer targets |

Additional constraints:
- Actors must themselves be active tenant owners/admins.
- Self-targeting is denied.
- No action promotes a member to `tenant_owner`; ownership transfer is a separate future workflow.
- Role changes apply only to active memberships and cannot be no-op transitions.
- Suspension is active → inactive; revocation is active/inactive → revoked; reactivation is inactive → active. Revoked memberships cannot be reactivated; a new invitation is required.
- The database requires a matching immutable event for every role/status update and prevents removal or demotion of the final active tenant owner.
- Event insert and membership update occur in the same D1 batch. A failed/mismatched write must not leave a partial state transition.
- Existing tenant resource grants are retained on suspension/revocation but are ineffective while membership is not active. They are not silently expanded during role changes.

## Site-level resource grants

`POST /api/v1/tenants/{tenant}/site-grants`

The active tenant owner or admin may grant or revoke one exact site/action grant for another active tenant member. The body fields are exactly `action` (`grant` or `revoke`), `subject`, `site_id`, `grant_action` and `reason`. Wildcards, inactive sites, inactive memberships, ambiguous targets and duplicate grants fail closed.

- Supported grant actions: `read`, `create`, `update`, `delete`, `ingest`, `manage_members`.
- Owners may grant/revoke all listed actions.
- Admins may grant/revoke only `read`, `create`, `update` and `ingest`; destructive `delete` and `manage_members` grants remain owner-only.
- Grant row mutation and its immutable `tenant_site_grant_events` audit event commit in one D1 batch.
- Revocation deletes only the exact matching grant ID, tenant, subject, site and action; it does not affect other sites or grants.
- Existing site grants are retained when a membership is suspended or revoked, but authorization requires active membership, so those grants do not authorize inactive users.
- This route does not create a site, change membership roles, or assign tenant-wide grants.

## Audit history

`GET /api/v1/tenants/{tenant}/membership-events`

Only active owners/admins may read the newest 100 tenant-scoped membership, invitation and site-grant events. Event rows are append-only. Membership events capture actor, subject, prior/new role, prior/new status, reason, request ID and timestamp. Invitation events capture the corresponding invitation lifecycle, actor, subject and reason.

## Explicitly not implemented

- Ownership transfer and owner promotion.
- Direct invitation by arbitrary email, verified email matching or automated identity-provider delivery.
- Asset/source/observation-specific grants and grant inheritance; only exact site-level grants are managed by this endpoint.
- Tenant suspension/archival lifecycle.
- Membership self-service or caller-selected subject changes.
- A live production provisioning allowlist, Access policy or D1 migration.

## Validation and release gates

The draft must pass exact-head API tests, gateway tests, ordered migrations against disposable local D1, query compatibility, fixture seeding and the end-to-end gateway → private Worker → D1 integration for membership and site-grant lifecycle. Security review must confirm that the provisioning allowlist is not tenant-modifiable. Production migration/deployment requires separate explicit approval.

