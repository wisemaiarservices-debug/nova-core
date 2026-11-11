# NOVA Core — controlled site and source registration

## Purpose and boundary

This procedure registers real sites and data sources in the shared NOVA Core D1 registry. It is an operator-controlled database procedure, not a public API. No unauthenticated client, dashboard, module browser, or ingestion service may create registry identities.

This document does not provision D1, activate a Worker binding, create credentials, or register example data. It deliberately contains no real site IDs, coordinates, source IDs, asset IDs, or provider credentials.

## Preconditions

Do not begin until all are true:

1. The D1 database exists in the intended Cloudflare account and the account owner has confirmed the current Free plan, quotas, and billing settings.
2. Migration `apps/api/migrations/0001_initial.sql` has been applied to the intended database.
3. `/api/v1/storage/status` reports `ready` for the Worker that will use the binding.
4. The operator has authorization to register the site and source, and has evidence for every supplied field.
5. The registration SQL is reviewed by a second operator before execution.

If any precondition is false, stop. Do not invent a pilot site or use connectivity-test coordinates as a real site.

## Registration evidence record

Prepare a private operator record before writing SQL. Keep it in the organization's approved records system, not in a public issue or browser bundle.

### Site evidence

- Stable site ID assigned by the organization; lowercase kebab-case is recommended.
- Official site name and, if available, a description.
- Latitude and longitude only when supplied or independently confirmed by the site owner. Coordinates must be a pair and WGS84 decimal degrees.
- IANA timezone only when confirmed.
- Evidence reference, who approved registration, and approval date.

### Source evidence

- Stable source ID assigned by the organization.
- Owning site ID, or explicitly global scope (`NULL`) where the source is genuinely shared.
- Exact module: `neoagro`, `neogrid`, `neocell`, or `nova-core`.
- Provider name and source type (for example, `gridded_weather`, `sensor_gateway`, or `manual`).
- Display name, endpoint reference (never an access token), license reference, and acquisition/verification method.
- Evidence reference and responsible owner.

New sources must remain `unverified`. A source is not verified merely because an API responds or a device is reachable.

## Preflight checks (read-only)

Run against the intended database before preparing inserts:

```sql
SELECT id, name, status FROM sites ORDER BY id;
SELECT id, site_id, module, provider, source_type, verification_status
FROM sources ORDER BY id;
SELECT name FROM sqlite_master
WHERE type = 'table'
  AND name IN ('sites', 'assets', 'sources', 'observations', 'audit_events')
ORDER BY name;
```

Confirm all five tables exist. Check that every proposed site/source ID is unused. If an ID already exists, do not overwrite it; investigate and reconcile through a reviewed change. Confirm the proposed source's module and site scope match the intended producer.

## Reviewed registration SQL pattern

Create a one-time SQL file locally from the approved evidence record. Replace every uppercase placeholder with reviewed, real values; do not leave placeholders in executable SQL. SQL text literals must use SQLite escaping (a single quote inside a string becomes two single quotes). Coordinates must be numeric literals within latitude/longitude bounds, or both `NULL`. Do not put secrets in this file.

The following is a pattern, not executable SQL:

```sql
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

INSERT INTO sites
  (id, name, description, latitude, longitude, timezone, status, metadata_json)
VALUES
  ('REAL_SITE_ID', 'APPROVED_SITE_NAME', 'APPROVED_DESCRIPTION',
   NULL, NULL, NULL, 'unconfigured', '{}');

INSERT INTO audit_events
  (id, actor_type, actor_id, action, entity_type, entity_id, details_json)
VALUES
  ('REAL_AUDIT_EVENT_ID', 'operator', 'APPROVED_OPERATOR_ID',
   'registry.site_registered', 'site', 'REAL_SITE_ID',
   '{"evidence_ref":"APPROVED_EVIDENCE_REFERENCE","review":"two-person-reviewed"}');

INSERT INTO sources
  (id, site_id, module, provider, source_type, display_name,
   endpoint_reference, verification_status, verification_method,
   license_reference, metadata_json)
VALUES
  ('REAL_SOURCE_ID', 'REAL_SITE_ID', 'APPROVED_MODULE',
   'APPROVED_PROVIDER', 'APPROVED_SOURCE_TYPE', 'APPROVED_DISPLAY_NAME',
   NULL, 'unverified', NULL, NULL, '{}');

INSERT INTO audit_events
  (id, actor_type, actor_id, action, entity_type, entity_id, details_json)
VALUES
  ('REAL_SOURCE_AUDIT_ID', 'operator', 'APPROVED_OPERATOR_ID',
   'registry.source_registered', 'source', 'REAL_SOURCE_ID',
   '{"evidence_ref":"APPROVED_SOURCE_EVIDENCE","verification_status":"unverified"}');

COMMIT;
```

The site remains `unconfigured` until its owner and operating scope are confirmed. Do not mark it `active` as part of initial registration by default. Sources remain `unverified` until a separate evidence-based verification review. For a global source, use `NULL` for `site_id` only when the source is genuinely not site-bound.

For a site that already exists, or when registering multiple records, prepare a transaction specifically for that case and review it before execution. Never use `INSERT OR REPLACE`, broad `UPDATE`, or `DELETE` to force registration through. Never silently reuse an ID for a different entity.

## Execute and verify

After the second operator approves the completed SQL file:

1. Confirm the database name and Cloudflare account in the Wrangler context.
2. Execute the reviewed file against the remote D1 database using the documented Wrangler D1 execute command. Do not execute against a production database unless the organization has explicitly designated it and approved the change.
3. If the command reports any error, stop and inspect the transaction state; do not blindly retry with new IDs.
4. Re-run the read-only preflight queries. Confirm exactly one site, one source, and their corresponding audit events exist.
5. Confirm the source has `verification_status='unverified'`, the site remains at its approved status, and no observations were inserted.
6. Check `/api/v1/storage/status` and Cloudflare D1 row/storage usage.
7. Record the SQL file hash, operator approvals, execution time, database name, and post-check results in the approved change record. Do not store tokens or secrets there.

## After registration

- Configure a service grant for the exact service identity, module, and registered source ID. No wildcards.
- Keep service credentials only in the trusted module backend and Cloudflare Worker secret storage.
- Run the authenticated ingestion acceptance tests from the ingestion runbook.
- Accept incoming observations as `unverified`; verification is a separate process.
- Enable a module producer only after the live Access, ownership, idempotency, audit, and D1 failure tests pass.
- Keep the public NOVA Core read API separate from the service-token-protected ingestion Worker.

## Rollback and audit

Do not delete a registered site/source to correct an error after observations may exist. Disable a source through a separately reviewed operator procedure, preserve audit history, and follow retention policy. Any correction must create an auditable event. Do not edit audit history to conceal an earlier registration.

## Current status

This is a documented operator procedure only. No D1 resource, registry record, Access policy, service token, or live producer has been created by this change. The API does not expose a public registration route.
