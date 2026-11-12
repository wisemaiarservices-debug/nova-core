-- Compile the tenant API's static query shapes against the actual local D1 schema.
-- EXPLAIN prepares each query without requiring tenant/customer data.
EXPLAIN SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status
FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
WHERE m.subject = 'fixture-subject' AND m.tenant_id = 'fixture-tenant' LIMIT 2;

EXPLAIN SELECT subject, tenant_id, resource_type, resource_id, action
FROM tenant_resource_grants
WHERE tenant_id = 'fixture-tenant' AND subject = 'fixture-subject'
AND resource_type = 'site' AND resource_id = 'fixture-site';

EXPLAIN SELECT id, tenant_id, name, description, latitude, longitude, timezone, status, metadata_json, created_at, updated_at
FROM sites WHERE tenant_id = 'fixture-tenant' AND id = 'fixture-site' LIMIT 1;

EXPLAIN SELECT id, tenant_id, site_id, name, asset_type, external_ref, status, metadata_json, created_at, updated_at
FROM assets WHERE tenant_id = 'fixture-tenant' AND id = 'fixture-asset' LIMIT 1;

EXPLAIN SELECT id, tenant_id, site_id, module, provider, source_type, display_name, verification_status, verification_method, license_reference, metadata_json, created_at, updated_at
FROM sources WHERE tenant_id = 'fixture-tenant' AND id = 'fixture-source' LIMIT 1;

EXPLAIN SELECT id, tenant_id, site_id, asset_id, source_id, module, metric, value, unit, observed_at, ingested_at, verification_status, provenance_json, quality_flags_json, retention_until
FROM observations WHERE tenant_id = 'fixture-tenant' AND id = 'fixture-observation' LIMIT 1;

EXPLAIN SELECT id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, request_id, details_json
FROM audit_events WHERE tenant_id = 'fixture-tenant' AND id = 'fixture-audit-event' LIMIT 1;

EXPLAIN INSERT INTO internal_request_nonces (request_id, issued_at, expires_at)
VALUES ('fixture-request-id', 1800000000, 1800000600)
ON CONFLICT(request_id) DO NOTHING;

-- Prepare the ingestion Worker's tenant-owned observation and audit insert shapes.
EXPLAIN INSERT OR IGNORE INTO observations
(id, site_id, asset_id, source_id, module, metric, value, unit, observed_at,
 idempotency_key, verification_status, provenance_json, quality_flags_json, tenant_id)
VALUES ('fixture-ingest-observation', 'fixture-site', 'fixture-asset', 'fixture-source',
 'neogrid', 'energy.solar_power', 1.0, 'kW', '2026-11-10T14:55:00.000Z',
 'fixture-idempotency', 'unverified', '{}', '[]', 'fixture-tenant');

EXPLAIN INSERT OR IGNORE INTO audit_events
(id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, request_id, details_json, tenant_id)
SELECT 'fixture-ingest-audit', 'service', 'fixture-service', 'observation.accepted',
 'observation', 'fixture-ingest-observation', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
 'fixture-request', '{}', 'fixture-tenant'
WHERE EXISTS (SELECT 1 FROM observations
 WHERE id = 'fixture-ingest-observation' AND tenant_id = 'fixture-tenant');
