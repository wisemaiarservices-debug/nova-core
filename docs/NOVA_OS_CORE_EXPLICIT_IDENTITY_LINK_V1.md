# NOVA Core ↔ NOVA OS explicit identity-link contract v1

Status: implementation contract and release gate. This document does not create identity links, grant access, provision tenants, or enable a route.

## 1. Problem and non-equivalence

NOVA OS authenticates browser users with Supabase Auth. NOVA Core authenticates human principals through a Cloudflare Access JWT. These are separate identity systems:

- Supabase Auth subject: the verified JWT `sub` (normally a project-scoped user UUID).
- NOVA Core principal: the verified Cloudflare Access JWT `sub`.
- NOVA OS Supabase tenant ID and NOVA Core tenant ID are separate identifiers.

No equality, derivation, email match, domain match, display-name match, or UUID-shape assumption may be used to link them. A Supabase Auth session alone is not a NOVA Core identity, and a Cloudflare Access session alone is not a NOVA OS Supabase tenant membership.

## 2. Required trust chain

A future production request from NOVA OS to NOVA Core must carry two independently authenticated proofs:

1. A Supabase Auth access token, verified server-side against one fixed, configured Supabase Auth issuer and audience. The verifier must validate signature, algorithm allowlist, issuer, audience, expiry, issued-at/not-before, and a bounded token size. Issuer/JWKS URLs come only from deployment configuration, never from JWT claims or request parameters.
2. A human Cloudflare Access JWT, verified server-side against the configured Access issuer and application audience. Service-token identities are not accepted as human users for this workflow.

The gateway derives both subjects only after cryptographic verification. It signs both identities and their issuers/audiences into the existing gateway-to-private-Worker HMAC envelope. The private Worker must reject missing, malformed, stale, replayed, or unsigned identity context. Browser-supplied identity headers, actor IDs, tenant IDs, role claims, and membership claims are never authoritative.

Do not forward a Supabase service-role key, Cloudflare service-token secret, or internal HMAC secret to the browser.

## 3. Two separate explicit bindings

### 3.1 Tenant-pair binding

A tenant-pair record explicitly connects one NOVA OS Supabase tenant to one NOVA Core tenant:

`(supabase_project_id, supabase_tenant_id) ↔ core_tenant_id`

Requirements:
- Both tenant records must already exist and be active in their respective systems.
- The Supabase project/issuer must match a fixed deployment configuration; a browser cannot select an arbitrary Supabase project.
- The Core tenant must be resolved by exact persisted ID and active status.
- The binding is requested and approved by authorized tenant owners in the respective systems. Approval evidence identifies both systems' authenticated owner subjects.
- Each Supabase tenant may map to at most one Core tenant within a configured Supabase project; each Core tenant may map to at most one Supabase tenant unless a separately reviewed many-to-one use case is explicitly designed.
- A tenant mapping does not create users, memberships, grants, sites, or data attribution.
- No matching by tenant name, slug, email domain, or similar IDs.

### 3.2 User identity binding

Within an approved tenant-pair binding, an explicit user binding connects:

`(supabase_project_id, supabase_user_sub) ↔ (access_issuer, access_subject)`

Requirements:
- Both JWTs must be independently verified during the request that submits the binding request.
- The binding request is scoped to one exact approved tenant pair.
- The requester cannot nominate another Supabase user or Access subject; both subjects are derived from the two verified proofs.
- The binding starts `pending` and confers no access.
- An active NOVA Core tenant owner (or an explicitly approved independent identity administrator role) must approve it using a separate authenticated Access identity.
- The approver must not be the Access subject being linked. A requester cannot approve their own binding.
- Approval rechecks the tenant is active, tenant-pair binding is active, approver is an active owner, request is pending, and both exact subjects remain unchanged.
- One active Supabase user binding per tenant pair and one active Access subject binding per tenant pair. Uniqueness is enforced in the database, not only in application code.
- Email is optional display/contact metadata only. It is never a matching key, proof of ownership, lookup fallback, or approval signal.
- Approval links identities only. It does not create or elevate NOVA Core membership, role, site grants, resource grants, or Supabase RLS membership.

## 4. Runtime authorization

For every bridged NOVA OS → NOVA Core request, the private Worker must require all of:

1. Both verified identity proofs in the signed envelope.
2. One exact active tenant-pair binding.
3. One exact active user identity binding for the verified Supabase subject and Access subject within that tenant pair.
4. An active NOVA Core tenant.
5. An active NOVA Core membership for the Access subject with the required role.
6. The existing exact site/resource grant and parent-scope checks for the requested operation.

No binding means deny. Multiple matching rows mean deny and alert; never select the first row. Suspended, revoked, expired, or tenant-mismatched bindings deny immediately. Do not cache positive bindings beyond the request unless revocation propagation and bounded cache invalidation are independently proven.

A link is not a bearer credential. Possession of a stored binding ID does not authenticate either principal.

## 5. Lifecycle and audit

The proposed lifecycle is:

- `pending` → `approved`
- `pending` → `rejected`
- `approved` → `revoked`

No transition reactivates a revoked link. A new request is required.

Each request, approval, rejection, revocation, and tenant-pair change must append an immutable audit event containing:
- tenant-pair ID and binding ID;
- exact Supabase project/tenant/user identifiers where applicable;
- exact Access issuer/subject identifiers;
- verified actor Access subject;
- action, previous/new state, bounded reason, unique request ID and server timestamp.

The database must prevent update/delete of audit rows, enforce state transitions and exact tuple consistency, and require each state mutation to be paired with its matching event in the same atomic D1 batch. No identity token or raw invitation/credential is stored in audit metadata.

Tenant-pair revocation disables every child user binding immediately without deleting history. User-link revocation disables only that exact link. Membership/grant state remains independently governed by NOVA Core.

## 6. API outline — not implemented by this document

Candidate endpoints, subject to implementation review:

- `POST /api/v1/identity/tenant-bindings/requests`
- `POST /api/v1/identity/tenant-bindings/{binding}/approve`
- `POST /api/v1/identity/tenant-bindings/{binding}/revoke`
- `POST /api/v1/tenants/{tenant}/identity-links/requests`
- `POST /api/v1/tenants/{tenant}/identity-links/{link}/approve`
- `POST /api/v1/tenants/{tenant}/identity-links/{link}/reject`
- `POST /api/v1/tenants/{tenant}/identity-links/{link}/revoke`

All mutations go through the Access gateway and private Worker. No direct browser-to-D1 writes. Approval routes derive actor from verified Access identity and recheck actor authority inside the mutation statement/batch.

## 7. Required security tests

### Cryptographic proof validation
- Valid Supabase + Access proofs for configured issuers/audiences.
- Missing one proof, malformed token, wrong issuer/audience, expired/not-yet-valid token, invalid signature, unsupported algorithm, oversized token, unknown key, JWKS failure, redirect, malformed/oversized JWKS.
- Reject service-token Access JWTs as human identities.
- Reject caller-supplied identity headers and altered signed-envelope fields.
- Reject replayed gateway request IDs.

### Binding workflow
- No auto-link by email, domain, display name, or coincident UUID.
- Request derives both subjects from verified JWTs; forged body subject fields rejected.
- Request remains pending and cannot be used for reads or writes.
- Only active Core owner approves; admin/operator/analyst/viewer denied unless a separately authorized role is introduced.
- Requester cannot approve own link; a different owner can approve.
- Cross-tenant/project binding, duplicate active subject, duplicate active Supabase user and duplicate tenant-pair mapping denied.
- Revoked/suspended tenant, pending/rejected/revoked link and ambiguous duplicate rows deny.
- Approval racing with owner suspension, tenant suspension or request revocation fails closed.
- Audit insert failure rolls back state mutation; UPDATE/DELETE audit rows fail.
- Tenant-pair revoke denies all child user links without deleting them.
- Link revocation denies immediately while Core membership and grants remain unchanged.
- Approved identity link never creates membership, role, site grant or resource grant.

### Runtime authorization
- Exact active pair + exact active user link + active membership + exact resource grant succeeds.
- Any missing/duplicate/inactive/mismatched layer denies.
- Same Supabase user linked to another Access subject does not authorize.
- Same Access subject linked under another tenant pair does not authorize.
- Site/resource grants are still exact and non-inheriting.

## 8. Rollout gates

1. Implement Supabase JWT verification in the gateway with fixed issuer/audience configuration and bounded JWKS handling.
2. Extend the signed envelope and private Worker verification to include both verified principals.
3. Add ordered D1 migrations, append-only ledgers and exact uniqueness constraints.
4. Implement pending request and independent owner approval routes.
5. Add gateway → private Worker → disposable D1 integration and negative security tests.
6. Connect NOVA OS only after the Core contract is merged/deployed and production issuer, Access audience, approved origins, tenant pair, and identity links are separately configured and reviewed.

Until all gates pass, NOVA OS must not send browser requests to tenant-protected Core APIs as if Supabase authentication alone were sufficient. The current PR #25 sign-in gate is only Supabase authentication; it does not establish a NOVA Core identity link.

## 9. Release boundary

This contract alone does not implement an identity verifier, identity-link table, route, migration, tenant mapping, user binding, or authorization bypass. No production configuration, secrets, data, tenant membership, grant, deployment, or paid service is changed.