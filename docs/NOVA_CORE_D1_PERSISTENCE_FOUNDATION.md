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


## Read-only runtime probe

The API now exposes `GET /api/v1/storage/status`. In the Python Workers ASGI request scope it reads the `DB` binding, executes a parameterized read-only query against SQLite's `sqlite_master`, and checks for the five expected tables. It reports one of:

- `unconfigured`: no Worker environment or no `DB` binding
- `unavailable`: the binding exists but the read query failed
- `schema_incomplete`: D1 is reachable but one or more expected tables are absent
- `ready`: the read query succeeded and all expected tables are present

The endpoint never returns SQL exception details and always reports `writes_enabled: false`. API `/health` remains an API-process check and is not coupled to D1 readiness. Automated tests use a small fake binding to exercise these states; they do not claim a live D1 database exists.

Cloudflare's Python Workers FastAPI integration exposes bindings through `request.scope["env"]`; the implementation uses the request scope and documented D1 prepared-statement API. See [Cloudflare Python Workers D1 example](https://developers.cloudflare.com/d1/examples/query-d1-from-python-workers/) and [FastAPI integration](https://developers.cloudflare.com/workers/languages/python/packages/fastapi/).

## Current deployment boundary

This PR does not add a `d1_databases` binding to Wrangler, provision a database, apply the migration, or deploy a new Worker version. The live endpoint will therefore correctly report `unconfigured` until an operator creates a D1 database, supplies its database ID in reviewed Wrangler configuration, applies the migration, and deploys. Do not add an unverified database ID or enable ingestion as part of this change.
