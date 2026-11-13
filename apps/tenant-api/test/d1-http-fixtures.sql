-- Isolated fixture records for local D1 HTTP integration only.
INSERT INTO tenants (id, display_name, status) VALUES
  ('tenant-http-a', 'CI Tenant A', 'active'),
  ('tenant-http-b', 'CI Tenant B', 'active');

INSERT INTO tenant_memberships (id, tenant_id, subject, role, status) VALUES
  ('membership-http-a', 'tenant-http-a', 'ci-human-subject', 'tenant_owner', 'active'),
  ('membership-http-reviewer', 'tenant-http-a', 'ci-config-reviewer', 'tenant_admin', 'active');

INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action) VALUES
  ('grant-http-a-site', 'tenant-http-a', 'ci-human-subject', 'site', 'site-http-a', 'read'),
  ('grant-http-a-site-create', 'tenant-http-a', 'ci-human-subject', 'site', 'site-http-a', 'create'),
  ('grant-http-a-site-update', 'tenant-http-a', 'ci-human-subject', 'site', 'site-http-a', 'update'),
  ('grant-http-reviewer-site-update', 'tenant-http-a', 'ci-config-reviewer', 'site', 'site-http-a', 'update'),
  ('grant-http-a-site-manage', 'tenant-http-a', 'ci-human-subject', 'site', 'site-http-a', 'manage_members');

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
