# NOVA Core tenant persistence migration V1

**Status:** draft migration and local SQLite contract tests. Not applied to Cloudflare D1. No database, tenant, membership, grant, or customer record has been provisioned.

## Scope

Migration `0002_tenant_isolation.sql` adds:

- A tenant registry with active, suspended, and archived states.
- One server-owned membership per tenant and stable identity subject, with bounded roles and active/inactive/revoked states.
- Exact per-resource, per-action grants. Wildcard resource IDs are rejected.
- Tenant ownership columns on sites, assets, sources, observations, and audit events.
- Indexes for tenant-scoped lookups.
- Database triggers that reject missing tenant ownership, cross-tenant site/asset/source/observation joins, and new membership/grant/writes for suspended tenants.

The migration deliberately does not invent a tenant or backfill existing rows. Existing records retain NULL tenant_id until an authorized operator performs a separately reviewed ownership assignment.

## Mandatory preflight before any D1 application

1. Confirm the target D1 database identity and environment.
2. Take and verify a recoverable backup/export.
3. Inspect row counts and all existing site, asset, source, observation, and audit relationships.
4. For every existing customer-owned row, obtain an approved tenant ownership mapping from authoritative records. Never infer ownership from names, coordinates, IDs, or module.
5. If any legacy row cannot be authoritatively assigned, keep it quarantined and inaccessible to tenant APIs.
6. Test the exact migration against a copy of the target schema and representative data, including foreign-key and trigger behavior.
7. Obtain explicit approval before applying to any shared or production D1 database.

## Application requirements after migration

- Every tenant-owned SELECT, UPDATE, DELETE, export, and aggregate query must include the authenticated tenant scope in the repository/data-access layer.
- Resolve membership and tenant status from trusted storage for every authorization context; the tenant must be active and exactly one membership must be active.
- Apply the policy in `services/tenant_authorization.py` after cryptographic identity verification and trusted membership/grant loading.
- For every non-tenant resource, require an exact grant for the subject, tenant, resource type, resource ID, and action.
- Keep public scientific provider endpoints separate from tenant configuration and observations.
- Treat database triggers as defense in depth, not as a replacement for query scoping or authorization.
- Do not expose a route that accepts a caller-supplied tenant ID as authority.

## Suspension and revocation

Suspending a tenant denies policy evaluation and prevents new site, asset, source, observation, membership, and grant writes. Memberships can still be set inactive or revoked during suspension. Existing records remain intact for retention, audit, and recovery; no automatic deletion is performed.

## Validation included

The companion tests use in-memory SQLite to validate migration structure, exact tenant membership uniqueness, wildcard grant rejection, active-tenant requirements, and same-tenant ownership across site, source, asset, and observation relationships. They do not prove Cloudflare D1 production behavior, application query scoping, JWT verification, or operational readiness.

## Release blocker

No tenant-facing API or customer onboarding flow may use these tables until a verified identity adapter, trusted membership/grant repository, mandatory tenant-scoped data-access interfaces, cross-tenant query tests, and independent security review are complete.
