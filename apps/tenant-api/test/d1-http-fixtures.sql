-- Isolated fixture records for local D1 HTTP integration only.
INSERT INTO tenants (id, display_name, status) VALUES
  ('tenant-http-a', 'CI Tenant A', 'active'),
  ('tenant-http-b', 'CI Tenant B', 'active');

INSERT INTO tenant_memberships (id, tenant_id, subject, role, status) VALUES
  ('membership-http-b-member', 'tenant-http-b', 'ci-other-tenant-member', 'viewer', 'active'),
  ('membership-http-a', 'tenant-http-a', 'ci-human-subject', 'tenant_owner', 'active'),
  ('membership-http-reviewer', 'tenant-http-a', 'ci-measurement-reviewer', 'viewer', 'active'),
  ('membership-http-lifecycle', 'tenant-http-a', 'ci-lifecycle-member', 'viewer', 'active'),
  ('membership-http-admin', 'tenant-http-a', 'ci-http-admin', 'tenant_admin', 'active'),
  ('membership-http-service-subject', 'tenant-http-a', 'neoagro-ingestion-service', 'viewer', 'active');

INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action) VALUES
  ('grant-http-a-site', 'tenant-http-a', 'ci-human-subject', 'site', 'site-http-a', 'read'),
  ('grant-http-a-site-create', 'tenant-http-a', 'ci-human-subject', 'site', 'site-http-a', 'create'),
  ('grant-http-a-reviewer-site', 'tenant-http-a', 'ci-measurement-reviewer', 'site', 'site-http-a', 'read'),
  ('grant-http-a-service-subject-site', 'tenant-http-a', 'neoagro-ingestion-service', 'site', 'site-http-a', 'read');

INSERT INTO sites (id, tenant_id, name, status) VALUES
  ('site-http-a', 'tenant-http-a', 'CI Site A', 'active'),
  ('site-http-b', 'tenant-http-b', 'CI Site B', 'active');


-- Test-only failure injection: the local D1 integration harness verifies that
-- a late audit failure rolls back the idempotency row, snapshot and review event.
CREATE TRIGGER ci_reject_configuration_audit
BEFORE INSERT ON audit_events
WHEN NEW.request_id = 'req-fail'
BEGIN
  SELECT RAISE(ABORT, 'ci_configuration_audit_failure');
END;

-- Synthetic CI-only criteria fixtures; never treated as regulatory evidence.
INSERT INTO water_quality_criteria_entries
(id, tenant_id, site_id, jurisdiction, version, title, entry_json,
 source_document_sha256, source_evidence_ref, published_on, effective_from, created_by_subject)
VALUES
('criteria-http-a', 'tenant-http-a', NULL, 'TN', '1.0', 'CI fixture only',
 '{"id":"criteria-http-a","jurisdiction":"TN","version":"1.0","title":"CI fixture only","criteria":[{"parameter":"ec","unit":"dS/m","operator":"max","value":2}]}',
 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 'fixture:ci-only', '2026-01-01', '2026-02-01', 'ci-fixture-author'),
('criteria-http-b', 'tenant-http-b', NULL, 'TN', '1.0', 'Other tenant fixture',
 '{"id":"criteria-http-b","jurisdiction":"TN","version":"1.0","title":"Other tenant fixture","criteria":[]}',
 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
 'fixture:ci-only', '2026-01-01', '2026-02-01', 'ci-fixture-author');

-- Persisted observation and ingestion audit fixture for the human verification workflow.
INSERT INTO sources
(id, site_id, tenant_id, module, provider, source_type, display_name, verification_status, metadata_json)
VALUES
('source-http-a', 'site-http-a', 'tenant-http-a', 'neoagro', 'CI fixture provider',
 'sensor', 'CI measurement source', 'unverified', '{}');

INSERT INTO observations
(id, site_id, tenant_id, source_id, module, metric, value, unit, observed_at,
 idempotency_key, verification_status, provenance_json, quality_flags_json)
VALUES
('obs-http-verified', 'site-http-a', 'tenant-http-a', 'source-http-a', 'neoagro',
 'ec', 1.5, 'dS/m', '2026-05-10T10:00:00Z', 'ci-observation-1', 'unverified',
 '{"provider":"CI fixture provider","acquisition_method":"manual"}', '[]');

INSERT INTO audit_events
(id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, request_id, details_json)
VALUES
('audit-http-observation', 'tenant-http-a', 'service', 'neoagro-ingestion-service',
 'observation.accepted', 'observation', 'obs-http-verified', 'ci-ingest-request',
 '{"verification_status":"unverified"}');


-- Test-only failure injection proves the grant row rolls back if its audit event fails.
CREATE TRIGGER ci_reject_resource_grant_audit
BEFORE INSERT ON tenant_resource_grant_events
WHEN NEW.reason = 'CI injected resource grant audit failure'
BEGIN
  SELECT RAISE(ABORT, 'ci_resource_grant_audit_failure');
END;

-- Verified source and active asset used only to exercise exact resource grants.
INSERT INTO assets (id, site_id, tenant_id, name, asset_type, status)
VALUES ('asset-http-grant', 'site-http-a', 'tenant-http-a', 'CI grant asset', 'sensor', 'active');
INSERT INTO assets (id, site_id, tenant_id, name, asset_type, status)
VALUES ('asset-http-b', 'site-http-b', 'tenant-http-b', 'Other tenant asset', 'sensor', 'active');

INSERT INTO sources
(id, site_id, tenant_id, module, provider, source_type, display_name, verification_status, metadata_json)
VALUES
('source-http-grant', 'site-http-a', 'tenant-http-a', 'neoagro', 'CI verified grant provider',
 'sensor', 'CI verified grant source', 'verified', '{}');

INSERT INTO observations
(id, site_id, tenant_id, asset_id, source_id, module, metric, value, unit, observed_at,
 idempotency_key, verification_status, provenance_json, quality_flags_json)
VALUES
('obs-http-grant', 'site-http-a', 'tenant-http-a', 'asset-http-grant', 'source-http-grant',
 'neoagro', 'soil_moisture', 0.24, 'm3/m3', '2026-11-13T10:00:00Z',
 'ci-resource-grant-observation', 'unverified', '{}', '[]');
