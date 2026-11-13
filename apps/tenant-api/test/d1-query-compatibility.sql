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
