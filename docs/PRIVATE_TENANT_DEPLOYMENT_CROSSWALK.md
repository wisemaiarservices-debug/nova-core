# Private tenant deployment configuration crosswalk

Status: **source-to-runbook reconciliation only — no resource provisioning or deployment authorization**.

This crosswalk records exact names and bindings in the checked-in configuration. Re-check the target commit before activation and require live readback; these source values are not proof of provisioned resources.

## Worker/configuration matrix

| Purpose | Wrangler config | Worker name | Entry point | Public exposure | D1 binding |
|---|---|---|---|---|---|
| Existing general/public API | `apps/api/wrangler.jsonc` | `nova-core-api` | `worker.py` | `workers_dev: true` | None declared |
| Private tenant API | `apps/api/wrangler.tenant.jsonc` | `nova-core-tenant-api` | `tenant_worker.py` | `workers_dev: false`; no route declared in this file | `DB` |
| Scheduled nonce cleanup | `apps/api/wrangler.nonce-cleanup.jsonc` | `nova-core-tenant-nonce-cleanup` | `nonce_cleanup_worker.py` | `workers_dev: false`; no route declared in this file | `TENANT_DB` |
| Access-facing tenant gateway | `apps/tenant-gateway/wrangler.jsonc` | `nova-core-tenant-gateway` | `src/index.mjs` | `workers_dev: false`; no route declared in this file | None |

**Critical config selection:** do not use `apps/api/wrangler.jsonc` to deploy the private tenant API. It names the existing general API Worker and explicitly enables `workers_dev`. The private tenant API uses `apps/api/wrangler.tenant.jsonc`.

The gateway config declares Service Binding `TENANT_API` targeting `nova-core-tenant-api`. The private API's D1 binding is `DB`; the cleanup Worker's binding is `TENANT_DB`. Both D1 configs use database name `nova-core-tenant-db` and currently contain the all-zero UUID sentinel. Replace the sentinel only in environment-specific deployment configuration after provisioning and independently reading back a real database ID. Never deploy either placeholder config unchanged.

## Migration inventory and ordering

The shared `apps/api/migrations` directory contains exactly these ordered migrations:

1. `0001_initial.sql` — foundational sites, assets, sources, observations and audit-event schema.
2. `0002_tenant_isolation.sql` — tenants, memberships, resource grants, tenant ownership columns, indexes and enforcement triggers.
3. `0003_internal_request_nonces.sql` — durable one-time assertion replay table and retention index.
4. `0004_site_tenant_transfer_guard.sql` — prevents changing a site's tenant while assets, sources or observations depend on it; preserves legacy-site ownership assignment when no dependent rows exist.
5. `0005_nonce_jti_not_null.sql` — rebuilds the nonce table with an explicit `NOT NULL` primary key, removes pre-existing null-key rows that cannot identify/replay-protect a request, and recreates the retention index.
6. `0006_site_audit_transfer_guard.sql` — prevents changing a site's tenant while any append-only site audit event references it, including legacy events with NULL tenant ownership.
7. `0007_site_audit_tenant_match_guard.sql` — requires new audit events for an existing site to use that site's current tenant ID; permits events for absent sites so post-deletion history can still be recorded.
8. `0008_site_id_reuse_guard.sql` — prevents recreating a deleted site ID when append-only site audit history already references that ID, avoiding reassignment of historical identity to another tenant.
9. `0009_related_entity_audit_guards.sql` — extends audit-tenant attribution checks and historical-ID reuse protection to assets, sources and observations.
10. `0010_tenant_membership_audit_guards.sql` — aligns tenant and membership audit attribution with current ownership, prevents membership tenant transfer after audit history, and blocks tenant/membership ID reuse or identity changes while history exists.
11. `0011_deleted_entity_audit_tenant_continuity.sql` — requires tombstone audit events for deleted entities to preserve the tenant attribution in all prior history, including the reserved experiment and dataset_snapshot entity types.

Both tenant API and cleanup Worker configs point `migrations_dir` to `migrations`. The cleanup Worker must use the same database and migration history as the private API.

### Migration-specific release gates

- **0002 legacy ownership:** the migration header says existing rows must be reviewed and assigned to an approved tenant before applying. It does not perform a backfill. The schema allows legacy rows to remain `tenant_id IS NULL`, but those rows must remain inaccessible to tenant-scoped APIs. Before applying, inventory every legacy row and record an approved ownership/backfill or quarantine disposition. Do not infer ownership from names, IDs or untrusted metadata. If any row cannot be safely assigned, stop and revise the migration/rollout plan rather than silently proceeding.
- **0004 site ownership:** a site with dependent assets, sources or observations cannot be reassigned to another tenant. A dedicated audited transfer workflow is required for that case; legacy sites with no dependent records can still receive an approved tenant assignment.
- **0005 nonce key integrity:** SQLite permits `NULL` in a `TEXT PRIMARY KEY` unless `NOT NULL` is explicit. This migration rebuilds the nonce table with an explicit non-null key and removes any pre-existing null-key rows, which cannot represent a valid assertion ID and cannot be addressed by the cleanup query. It preserves all valid keyed rows and recreates the retention index.
- **0006 site audit immutability:** a site with any append-only audit event cannot change tenant ownership, including when the historical event still has `tenant_id IS NULL`. Resolve legacy ownership explicitly; do not reassign the site around its audit history.
- **0007 site audit attribution:** new audit events for an existing site must carry the same tenant ID as the site. Events whose site row is already absent remain permitted to support post-deletion/tombstone history.
- **0008 site ID reuse:** a deleted site identifier cannot be recreated while any append-only site audit event still references it. A future restore/reuse workflow must explicitly reconcile the historical identity and tenant ownership rather than silently attaching old history to a new site.
- **0009 related entity audit integrity:** new audit events for existing assets, sources and observations must carry the same tenant ID as the referenced entity. Their identifiers cannot be reused after deletion while append-only audit history remains. Post-deletion tombstone events remain permitted when the entity row is absent.
- **0010 tenant and membership audit integrity:** tenant audit events must use the tenant's own ID as tenant_id; membership audit events must use the membership's current tenant. Membership tenant transfers, and tenant/membership ID changes or reuse, are blocked while append-only audit history exists.
- **0011 deleted-entity audit continuity:** when a referenced entity row is absent, any later tombstone audit event must preserve the tenant attribution recorded by every prior event for that entity ID. The comparison is NULL-safe, so legacy NULL attribution cannot be silently reassigned. This also protects experiment and dataset_snapshot audit histories until their resource tables are introduced with equivalent live-row owner guards.
- **0003 production prohibition:** the current migration header explicitly says it must only be applied to a disposable/staging D1 database. Therefore **0003 is not currently authorized for production**, even though both Worker configs include the shared migrations directory. Before any production private-tenant deployment, revise that migration's release contract through a reviewed source change, prove the migration on isolated D1, and obtain a separate explicit production migration gate. Do not apply 0003 to production under the current source contract.

A controlled isolated-database command sequence, run from the repository root with an environment-specific config copy pointing to a verified disposable/staging database, is:

```sh
npx wrangler d1 migrations list nova-core-tenant-db --remote --config <isolated-tenant-api-config>
npx wrangler d1 migrations apply nova-core-tenant-db --remote --config <isolated-tenant-api-config>
npx wrangler d1 migrations list nova-core-tenant-db --remote --config <isolated-tenant-api-config>
```

This is an execution template, not evidence that migrations have run. Capture before/after migration lists and schema checks. Never substitute production identifiers into this staging procedure.

## Cleanup schedule

The cleanup Worker config schedules `17 * * * *` (minute 17 of every UTC hour). Its source contract uses one parameterized delete, ordered by retention expiry, and bounds each invocation to at most 500 rows whose `retained_until` is at or before the scheduled event time. Verify deployed cron readback and a controlled cleanup execution; source configuration alone is not proof.

## Required activation readbacks

- Private API Worker name, `workers_dev: false`, no public route, and `DB` bound to the verified tenant D1 database.
- Cleanup Worker name, cron schedule, and `TENANT_DB` bound to that exact same D1 database.
- Gateway Worker name, `workers_dev: false`, protected hostname/Access policy, and `TENANT_API` Service Binding target exactly `nova-core-tenant-api`.
- No deployed Worker uses the all-zero D1 sentinel.
- Migration 0002 has an approved legacy-row disposition; migration 0003's staging-only restriction has been resolved through a reviewed source change before any production use.
- The general API Worker config has not been substituted for the private tenant API config.

The activation checklist remains authoritative for secrets, Access, security tests, observability, rate limiting, rollback and final release decision. **Production remains HOLD** until every gate is evidenced.
