# NOVA water-quality criteria registry read API

## Routes

Both routes are served by the Access-verified tenant gateway and the private tenant API Worker:

- `GET /api/v1/tenants/{tenant_id}/water-quality-criteria`
- `GET /api/v1/tenants/{tenant_id}/water-quality-criteria/{entry_id}/{version}`

The list route returns at most 100 rows ordered by jurisdiction, entry ID and version. The detail route resolves one exact tenant, entry ID and version tuple. Stored `entry_json` is parsed and returned as `entry`.

## Authorization

The gateway validates the Cloudflare Access human JWT and creates a fresh HMAC-signed internal identity envelope. The private Worker verifies issuer, audience, freshness, signature and one-time request ID. It then requires exactly one active membership for the verified subject and requested tenant, an active tenant, and a role with read permission.

Tenant ID, entry ID and version are path selectors, never caller-provided identity claims. D1 queries bind every selector and scope by tenant ID. Unknown entries, versions, memberships, roles and tenant scopes return the same not-found response. The gateway forwards no caller cookies or trust headers.

## Scope and limitations

- Read-only. This API does not create drafts, submit entries, assign reviewers, approve/reject, supersede or retire entries.
- Registry reads are tenant-wide and use tenant membership read permission. This initial API does not expose site-specific filters or site resource-grant authorization.
- Entry JSON and evidence references are caller-supplied registry data. The API does not fetch or hash source documents, authenticate issuers, verify current law, independently validate reviewer credentials, or establish regulatory compliance.
- A criteria comparison against a supplied entry remains an arithmetic comparison, not scientific suitability or operational authorization.
- The 100-row cap is a bounded first version; pagination is not implemented.

## Verification

Unit tests cover gateway route mapping, caller header/cookie isolation, signed identity envelope handling, active membership and role enforcement, duplicate membership denial, exact tenant/version SQL selectors and unknown-version denial.

The CI local D1 integration applies ordered migrations to disposable local D1, seeds synthetic CI-only registry entries, then exercises list and exact-version reads through the actual local gateway-to-private-Worker Service Binding. The fixtures are synthetic and are not regulatory data.

No remote D1, production secret, public Worker ingress, production deployment, paid resource, customer data, merge or operational decision is part of this change.
