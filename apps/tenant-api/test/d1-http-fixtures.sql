-- Isolated fixture records for local D1 HTTP integration only.
INSERT INTO tenants (id, display_name, status) VALUES
  ('tenant-http-a', 'CI Tenant A', 'active'),
  ('tenant-http-b', 'CI Tenant B', 'active');

INSERT INTO tenant_memberships (id, tenant_id, subject, role, status) VALUES
  ('membership-http-b-member', 'tenant-http-b', 'ci-other-tenant-member', 'viewer', 'active'),
  ('membership-http-b-owner', 'tenant-http-b', 'ci-tenant-b-owner', 'tenant_owner', 'active'),
  ('membership-http-a', 'tenant-http-a', 'ci-human-subject', 'tenant_owner', 'active'),
  ('membership-http-reviewer', 'tenant-http-a', 'ci-measurement-reviewer', 'viewer', 'active'),
  ('membership-http-lifecycle', 'tenant-http-a', 'ci-lifecycle-member', 'viewer', 'active'),
  ('membership-http-admin', 'tenant-http-a', 'ci-http-admin', 'tenant_admin', 'active'),
  ('membership-http-command-resolver', 'tenant-http-a', 'ci-command-resolver', 'tenant_admin', 'active'),
  ('membership-http-service-subject', 'tenant-http-a', 'neoagro-ingestion-service', 'viewer', 'active');

INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action) VALUES
  ('grant-http-a-site', 'tenant-http-a', 'ci-human-subject', 'site', 'site-http-a', 'read'),
  ('grant-http-a-site-create', 'tenant-http-a', 'ci-human-subject', 'site', 'site-http-a', 'create'),
  ('grant-http-a-reviewer-site', 'tenant-http-a', 'ci-measurement-reviewer', 'site', 'site-http-a', 'read'),
  ('grant-http-a-command-resolver-site', 'tenant-http-a', 'ci-command-resolver', 'site', 'site-http-a', 'read'),
  ('grant-http-a-admin-site', 'tenant-http-a', 'ci-http-admin', 'site', 'site-http-a', 'read'),
  ('grant-http-a-service-subject-site', 'tenant-http-a', 'neoagro-ingestion-service', 'site', 'site-http-a', 'read'),
  ('grant-http-b-owner-site', 'tenant-http-b', 'ci-tenant-b-owner', 'site', 'site-http-b', 'read');

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
 'sensor', 'CI measurement source', 'verified', '{}');
UPDATE sources SET registered_by_subject='ci-human-subject' WHERE id='source-http-a';
INSERT INTO tenant_source_reviewers
(tenant_id,site_id,reviewer_subject,status,assigned_by_subject,evidence_ref)
VALUES ('tenant-http-a','site-http-a','ci-measurement-reviewer','active','ci-human-subject',
 'fixture:source-reviewer-appointment');
INSERT INTO tenant_source_reviewer_events
(id,tenant_id,site_id,reviewer_subject,actor_subject,event_type,evidence_ref,request_id)
VALUES ('source-http-a-reviewer-assigned','tenant-http-a','site-http-a','ci-measurement-reviewer',
 'ci-human-subject','assigned','fixture:source-reviewer-appointment','ci-source-reviewer-assigned');
INSERT INTO tenant_source_events
(id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id,occurred_at)
VALUES
('source-http-a-registered','tenant-http-a','site-http-a','source-http-a',
 'ci-human-subject','registered','fixture:source-registration',NULL,'ci-source-registration','2026-01-01T00:00:00.000Z'),
('source-http-a-verified','tenant-http-a','site-http-a','source-http-a',
 'ci-measurement-reviewer','verified','fixture:source-verification',NULL,'ci-source-verified','2026-01-02T00:00:00.000Z');
INSERT INTO observations
(id, site_id, tenant_id, source_id, module, metric, value, unit, observed_at,
 idempotency_key, verification_status, provenance_json, quality_flags_json)
VALUES
('obs-http-source-revocation', 'site-http-a', 'tenant-http-a', 'source-http-a', 'neoagro',
 'ec', 1.5, 'dS/m', '2026-05-10T10:00:00Z', 'ci-source-revocation-observation',
 'verified', '{"provider":"CI fixture provider","acquisition_method":"manual"}', '[]');


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


-- Complete, synthetic governance chain for lifecycle revocation during an active
-- assessment operation. These rows are CI-only and are not scientific evidence.
INSERT INTO laboratory_report_evidence
(id,tenant_id,site_id,evidence_type,file_name,media_type,byte_length,sha256,document_bytes,
 laboratory_name,report_number,sample_reference,issued_at,uploaded_by_subject)
VALUES
('lab-http-calibration','tenant-http-a','site-http-a','laboratory_report','ci-calibration.pdf',
 'application/pdf',1,'6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',X'00',
 'CI fixture laboratory','CI-CAL-001','sensor-http-revocation','2026-01-02T00:00:00Z','ci-human-subject');
INSERT INTO laboratory_report_evidence_events
(id,evidence_id,tenant_id,site_id,event_type,actor_subject,request_id)
VALUES
('lab-http-calibration-registered','lab-http-calibration','tenant-http-a','site-http-a',
 'registered','ci-human-subject','ci-lab-calibration-registration');

INSERT INTO sensor_source_mapping_reviewers
(tenant_id,site_id,reviewer_subject,status,assigned_by_subject,evidence_ref)
VALUES
('tenant-http-a','site-http-a','ci-measurement-reviewer','active','ci-human-subject',
 'fixture:mapping-reviewer-appointment');
INSERT INTO sensor_source_identity_mappings
(id,tenant_id,site_id,asset_id,source_id,sensor_id,parameter,unit,effective_from,effective_to,
 mapping_method,evidence_ref,registered_by_subject)
VALUES
('mapping-http-revocation','tenant-http-a','site-http-a','asset-http-grant','source-http-a',
 'sensor-http-revocation','ec','dS/m','2026-01-01T00:00:00Z',NULL,
 'CI exact identity fixture','fixture:mapping-http-revocation','ci-human-subject');
INSERT INTO sensor_source_mapping_events
(id,tenant_id,site_id,asset_id,source_id,mapping_id,reviewer_subject,event_type,evidence_ref,reason,request_id)
VALUES
('mapping-http-revocation-verified','tenant-http-a','site-http-a','asset-http-grant','source-http-a',
 'mapping-http-revocation','ci-measurement-reviewer','verified',
 'fixture:mapping-http-revocation-verification',NULL,'ci-mapping-http-revocation-verified');

INSERT INTO sensor_calibration_reviewers
(tenant_id,site_id,reviewer_subject,reviewer_role,status,assigned_by_subject,assignment_evidence_ref)
VALUES
('tenant-http-a','site-http-a','ci-measurement-reviewer','calibration_reviewer','active',
 'ci-human-subject','fixture:calibration-reviewer-appointment');
INSERT INTO sensor_calibrations
(id,tenant_id,site_id,asset_id,sensor_id,parameter,unit,calibration_method,calibrated_at,valid_until,
 laboratory_name,certificate_evidence_id,reference_value,as_found_value,as_left_value,uncertainty,
 notes,registered_by_subject)
VALUES
('cal-http-revocation','tenant-http-a','site-http-a','asset-http-grant','sensor-http-revocation',
 'ec','dS/m','CI reference method','2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',
 'CI fixture laboratory','lab-http-calibration',1.5,1.6,1.5,0.01,
 'Synthetic CI fixture only','ci-human-subject');
INSERT INTO sensor_calibration_events
(id,calibration_id,tenant_id,site_id,event_type,actor_subject,request_id)
VALUES
('cal-http-revocation-registered','cal-http-revocation','tenant-http-a','site-http-a',
 'registered','ci-human-subject','ci-calibration-http-registration');
INSERT INTO sensor_calibration_verification_events
(id,tenant_id,site_id,asset_id,calibration_id,reviewer_subject,reviewer_role,event_type,evidence_ref,reason,request_id)
VALUES
('cal-http-revocation-verified','tenant-http-a','site-http-a','asset-http-grant',
 'cal-http-revocation','ci-measurement-reviewer','calibration_reviewer','verified',
 'lab-http-calibration',NULL,'ci-calibration-http-verified');

INSERT INTO measurement_quality_policies
(id,tenant_id,site_id,asset_id,sensor_id,parameter,unit,version,minimum_value,maximum_value,
 effective_from,effective_to,method,evidence_ref,registered_by_subject)
VALUES
('policy-http-revocation','tenant-http-a','site-http-a','asset-http-grant','sensor-http-revocation',
 'ec','dS/m','ci-v1',0,2,'2026-01-01T00:00:00Z',NULL,
 'CI deterministic comparison','fixture:policy-http-revocation','ci-human-subject');

INSERT INTO observations
(id,site_id,tenant_id,asset_id,source_id,module,metric,value,unit,observed_at,idempotency_key,
 verification_status,provenance_json,quality_flags_json)
VALUES
('obs-http-governance-revocation','site-http-a','tenant-http-a','asset-http-grant','source-http-a',
 'neoagro','ec',1.5,'dS/m','2026-05-10T10:00:00Z','ci-governance-revocation-observation',
 'verified','{"provider":"CI fixture provider","acquisition_method":"manual"}','[]');
