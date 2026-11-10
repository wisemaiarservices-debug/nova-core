# NOVA Core — D1 persistence foundation

## Status

This is a proposed, versioned SQLite schema for Cloudflare D1. It is a **schema-only foundation**: it does not provision a D1 database, add a Worker binding, expose write endpoints, or change the deployed Worker. The API remains stateless with respect to persisted site and observation records until a separately reviewed implementation is enabled.

Migration: `apps/api/migrations/0001_initial.sql`

## Data model

- `sites`: named project sites. Coordinates are optional and must be supplied by an authorized operator; the schema does not seed a pilot location.
- `assets`: equipment or infrastructure assets belonging to a site.
- `sources`: provider, module, source type, license reference and verification status. New sources default to `unverified`.
- `observations`: typed metric values with units, observed/ingested timestamps, source link, idempotency key, provenance, quality flags and optional retention deadline. New observations default to `unverified`.
- `audit_events`: append-oriented record of actor, action, entity, request and details. Application permissions must prevent ordinary clients from editing or deleting audit history.

Foreign keys use restrictive deletion so a site, source or asset cannot be silently removed while referenced by observations. Asset/site composite integrity prevents attaching an asset from another site. A unique source/idempotency-key index prevents duplicate ingestion when a caller retries a request.

## Provenance and trust

The schema stores provenance and quality metadata as validated JSON. It does not itself prove that a value is accurate. A future ingestion service must record, at minimum, source identity, acquisition method, event time, ingestion time, unit, verification state and quality flags. NASA POWER gridded/model-derived values must retain that interpretation and must not be relabelled as local sensor telemetry.

## Security requirements before enabling writes

1. Provision D1 in a non-production environment first and apply migrations there.
2. Bind the database to the Worker using a documented Python Workers-compatible binding and test the exact runtime API.
3. Keep write routes disabled until authenticated operator/service identity, authorization scopes, request-size limits and rate limits are implemented.
4. Validate site/source ownership, metric/unit contracts, timestamps, payload JSON and idempotency before insert.
5. Write audit events in the same transaction as each accepted mutation.
6. Never accept client-supplied `verified` status as proof. Verification must be assigned by a trusted server-side process.
7. Define retention and deletion procedures before collecting personal, sensitive or operationally critical data.
8. Keep health checks separate from database readiness; report storage as unconfigured until the binding is actually present and queried successfully.

## Not included

No autonomous device control, actuator command endpoint, model-training pipeline, authentication system, production database, or live telemetry ingestion is introduced here. No production resources or billing settings are changed. D1 free-tier quotas and limits must be checked in the Cloudflare account before provisioning; do not assume zero cost from the existence of a free tier.

## Read-only storage status endpoint

The current follow-on implementation adds:

- `GET /api/v1/storage/status`
- `unconfigured` when the Worker request has no `DB` binding
- `unavailable` when the binding exists but its metadata query fails
- `schema_incomplete` when one or more required tables are absent
- `ready` only when all five required tables are found

The endpoint uses the request-scoped Worker environment (`request.scope["env"]`) so it can access bindings attached to the ASGI-hosted FastAPI request. It executes only a parameterized `SELECT` against SQLite's table metadata. It never creates or mutates records. `/health` remains an independent API-process check.

## Cloudflare D1 binding activation (operator step)

After the migration and adapter PRs are reviewed:

1. In Cloudflare Dashboard, open **Storage & databases → D1 SQL Database** and create a database named `nova-core-db` in the intended account/region. Review the current D1 Free plan quotas and account billing before creating it.
2. Copy the database UUID from the D1 database overview. Do not paste credentials or account tokens into GitHub issues or chat.
3. Add a `d1_databases` entry to `apps/api/wrangler.jsonc` with binding `DB`, database name `nova-core-db`, and the actual database UUID. Do not commit a placeholder UUID.
4. Ensure the GitHub Actions Cloudflare token has the minimum D1 permission needed for migrations as well as the existing Workers deployment permission.
5. Apply `apps/api/migrations/0001_initial.sql` to the intended database using Wrangler's D1 migration workflow. Verify the migration history and tables before deploying a Worker build that contains the binding.
6. Deploy only after the binding is configured. Then check `/api/v1/storage/status`; expected status is `ready` only when all five tables are present.

Until those operator steps are completed, the live API must continue to report storage as unconfigured. No D1 database is created by this repository change.