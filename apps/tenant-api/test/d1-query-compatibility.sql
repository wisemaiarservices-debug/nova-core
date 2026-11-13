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

EXPLAIN SELECT request_sha256, configuration_id, status, response_json
FROM tenant_site_configuration_idempotency
WHERE tenant_id = 'fixture-tenant' AND subject = 'fixture-subject'
AND idempotency_key = 'fixture-idempotency-key' LIMIT 2;

EXPLAIN INSERT INTO tenant_site_configuration_idempotency
(tenant_id, subject, idempotency_key, request_sha256, configuration_id, status)
VALUES ('fixture-tenant', 'fixture-subject', 'fixture-idempotency-key',
'repeat0000000000000000000000000000000000000000000000000000000000000000',
'fixture-configuration', 'pending');

-- Prepare the authorization predicate executed again inside the atomic write batch.
EXPLAIN INSERT INTO tenant_site_configuration_idempotency
(tenant_id, subject, idempotency_key, request_sha256, configuration_id, status)
SELECT 'fixture-tenant', 'fixture-subject', 'fixture-idempotency-key',
'repeat0000000000000000000000000000000000000000000000000000000000000000',
'fixture-configuration', 'pending'
WHERE (SELECT COUNT(*) FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
WHERE m.subject = 'fixture-subject' AND m.tenant_id = 'fixture-tenant'
AND m.status = 'active' AND t.status = 'active'
AND m.role IN ('tenant_owner', 'tenant_admin')) = 1
AND (SELECT COUNT(*) FROM tenant_resource_grants WHERE tenant_id = 'fixture-tenant'
AND subject = 'fixture-subject' AND resource_type = 'site'
AND resource_id = 'fixture-site' AND action = 'create') = 1;

EXPLAIN INSERT INTO tenant_site_configurations
(id, tenant_id, site_id, configuration_version, schema_id, configuration_json,
 content_sha256, created_by_subject, request_id, created_at)
VALUES ('fixture-configuration', 'fixture-tenant', 'fixture-site',
'v' || CAST((SELECT COALESCE(MAX(CAST(substr(configuration_version, 2) AS INTEGER)), 0) + 1
FROM tenant_site_configurations WHERE tenant_id = 'fixture-tenant'
AND site_id = 'fixture-site') AS TEXT),
'nova.client-config.v1', '{}',
'repeat0000000000000000000000000000000000000000000000000000000000000000',
'fixture-subject', 'fixture-request-id', '2026-11-13T00:00:00.000Z');

EXPLAIN INSERT INTO tenant_site_configuration_events
(id, configuration_id, tenant_id, site_id, event_type, actor_subject, reason, request_id, occurred_at)
VALUES ('fixture-event', 'fixture-configuration', 'fixture-tenant', 'fixture-site',
'submitted_for_review', 'fixture-subject', NULL, 'fixture-request-id',
'2026-11-13T00:00:00.000Z');

EXPLAIN INSERT INTO audit_events
(id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, request_id, details_json)
VALUES ('fixture-audit', 'fixture-tenant', 'operator', 'fixture-subject',
'configuration.created_for_review', 'site', 'fixture-site',
'2026-11-13T00:00:00.000Z', 'fixture-request-id', '{}');

EXPLAIN UPDATE tenant_site_configuration_idempotency
SET status = 'completed',
response_json = (SELECT json_object('configuration_id', c.id,
'configuration_version', c.configuration_version, 'site_id', c.site_id,
'schema_id', c.schema_id, 'content_sha256', c.content_sha256,
'request_id', c.request_id, 'created_at', c.created_at)
FROM tenant_site_configurations c
WHERE c.id = tenant_site_configuration_idempotency.configuration_id
AND c.tenant_id = tenant_site_configuration_idempotency.tenant_id)
WHERE tenant_id = 'fixture-tenant' AND subject = 'fixture-subject'
AND idempotency_key = 'fixture-idempotency-key' AND status = 'pending';

EXPLAIN SELECT id, site_id, jurisdiction, version, title, entry_json,
source_document_sha256, source_evidence_ref, published_on, effective_from,
effective_to, supersedes_entry_id, supersedes_entry_version, created_by_subject, created_at
FROM water_quality_criteria_entries
WHERE tenant_id = 'fixture-tenant'
ORDER BY jurisdiction, id, version LIMIT 100;

EXPLAIN SELECT id, site_id, jurisdiction, version, title, entry_json,
source_document_sha256, source_evidence_ref, published_on, effective_from,
effective_to, supersedes_entry_id, supersedes_entry_version, created_by_subject, created_at
FROM water_quality_criteria_entries
WHERE tenant_id = 'fixture-tenant' AND id = 'fixture-criteria'
AND version = '1.0' LIMIT 1;

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
