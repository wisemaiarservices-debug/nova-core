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

Both tenant API and cleanup Worker configs point `migrations_dir` to `migrations`. Apply and verify this ordered set once against the intended isolated D1 database before deploying either Worker. The cleanup Worker must use that same database and migration history.

Migration 0002 does not invent tenant ownership for existing rows. Rows without an approved `tenant_id` remain outside tenant-scoped access. Before any production migration, inventory legacy rows, approve ownership/backfill or quarantine, and verify the NULL-ownership behavior is acceptable. Do not infer ownership from names, IDs or untrusted metadata.

A controlled isolated-database command sequence, run from the repository root with an environment-specific config copy pointing to the verified isolated database, is:

```sh
npx wrangler d1 migrations list nova-core-tenant-db --remote --config <isolated-tenant-api-config>
npx wrangler d1 migrations apply nova-core-tenant-db --remote --config <isolated-tenant-api-config>
npx wrangler d1 migrations list nova-core-tenant-db --remote --config <isolated-tenant-api-config>
```

This is an execution template, not evidence that migrations have run. Capture before/after migration lists and schema checks. Do not execute against production as part of this source change.

## Cleanup schedule

The cleanup Worker config schedules `17 * * * *` (minute 17 of every UTC hour). Its source contract bounds each invocation to one parameterized delete of at most 500 rows whose `retained_until` is at or before the scheduled event time. Verify deployed cron readback and a controlled cleanup execution; source configuration alone is not proof.

## Required activation readbacks

- Private API Worker name, `workers_dev: false`, no public route, and `DB` bound to the verified tenant D1 database.
- Cleanup Worker name, cron schedule, and `TENANT_DB` bound to that exact same D1 database.
- Gateway Worker name, `workers_dev: false`, protected hostname/Access policy, and `TENANT_API` Service Binding target exactly `nova-core-tenant-api`.
- No deployed Worker uses the all-zero D1 sentinel.
- Migrations 0001, 0002 and 0003 are applied in order; schema integrity and legacy-row disposition are documented.
- The general API Worker config has not been substituted for the private tenant API config.

The activation checklist remains authoritative for secrets, Access, security tests, observability, rate limiting, rollback and final release decision. **Production remains HOLD** until every gate is evidenced.
