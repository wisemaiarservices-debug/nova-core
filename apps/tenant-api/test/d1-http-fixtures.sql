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
  ('membership-http-service-subject', 'tenant-http-a', 'neoagro-ingestion-service', 'viewer', 'active');

INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action) VALUES
  ('grant-http-a-site', 'tenant-http-a', 'ci-human-subject', 'site', 'site-http-a', 'read'),
  ('grant-http-a-site-create', 'tenant-http-a', 'ci-human-subject', 'site', 'site-http-a', 'create'),
  ('grant-http-a-reviewer-site', 'tenant-http-a', 'ci-measurement-reviewer', 'site', 'site-http-a', 'read'),
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
-- Synthetic source-capability lifecycle happy path. This proves that a capability
-- starts pending, requires creator submission, and becomes approved only after an
-- independently assigned active reviewer records the approval event.
INSERT INTO source_capabilities
(id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,
 quantity_semantics,acquisition_protocol,protocol_version,sampling_mode,interval_seconds,
 max_age_seconds,max_future_skew_seconds,timezone,allowed_quality_flags_json,
 calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,version,status,
 created_by_subject)
VALUES
('capability-http-a','tenant-http-a','site-http-a','source-http-a',NULL,'neoagro','ec','dS/m',
 'measured','Electrical conductivity of irrigation water','manual-lab','1.0','interval',3600,
 31536000,300,'Africa/Tunis','["estimated","suspect"]',0,NULL,
 'source-rights:ci-http-a','source-evidence:ci-http-a',1,'pending','ci-human-subject');

INSERT INTO source_capability_events
(id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
VALUES
('capability-http-a-submitted','capability-http-a','tenant-http-a','site-http-a','source-http-a',
 'ci-human-subject','submitted','fixture:capability-submission',NULL,'ci-capability-submit');



-- The approved status is applied by the event trigger; the unique event index
-- and review guards make duplicate, out-of-order, or self-approved events fail.
-- Keep this fixture D1-compatible: no temporary tables or test-only schema objects.







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


-- Exact asset-scoped capability for the resource-grant observation fixture.
INSERT INTO source_capabilities
(id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,
 quantity_semantics,acquisition_protocol,protocol_version,sampling_mode,interval_seconds,
 max_age_seconds,max_future_skew_seconds,timezone,allowed_quality_flags_json,
 calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,version,status,
 created_by_subject)
VALUES
('capability-http-grant','tenant-http-a','site-http-a','source-http-grant','asset-http-grant',
 'neoagro','soil_moisture','m3/m3','measured','CI soil moisture fixture',
 'manual-lab','1.0','interval',3600,31536000,300,'Africa/Tunis','[]',
 0,NULL,'source-rights:ci-http-grant-asset','source-evidence:ci-http-grant-asset',1,'pending','ci-human-subject');
INSERT INTO source_capability_events
(id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
VALUES
('capability-http-grant-submitted','capability-http-grant','tenant-http-a','site-http-a','source-http-grant',
 'ci-human-subject','submitted','fixture:capability-submission',NULL,'ci-capability-grant-submit');





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

-- A profile is a stable reference to the exact verified source/sensor mapping.
-- It does not assert that a calibration record is currently valid.
INSERT INTO source_calibration_profiles
(profile_ref,tenant_id,site_id,asset_id,source_id,mapping_id,parameter,unit,evidence_ref,created_by_subject)
VALUES
('profile-http-calibration','tenant-http-a','site-http-a','asset-http-grant','source-http-a',
 'mapping-http-revocation','ec','dS/m','fixture:calibration-profile','ci-human-subject');

-- A separate mapping with no review event is used to prove pending mappings
-- cannot be promoted into a calibration profile.
INSERT INTO sensor_source_identity_mappings
(id,tenant_id,site_id,asset_id,source_id,sensor_id,parameter,unit,effective_from,effective_to,
 mapping_method,evidence_ref,registered_by_subject)
VALUES
('mapping-http-pending','tenant-http-a','site-http-a','asset-http-grant','source-http-a',
 'sensor-http-pending','ec','dS/m','2026-01-01T00:00:00Z',NULL,
 'CI pending mapping fixture','fixture:mapping-http-pending','ci-human-subject');

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


-- Asset-scoped calibration-required capability for the governance assessment fixture.
INSERT INTO source_capabilities
(id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,
 quantity_semantics,acquisition_protocol,protocol_version,sampling_mode,interval_seconds,
 max_age_seconds,max_future_skew_seconds,timezone,allowed_quality_flags_json,
 calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,version,status,
 created_by_subject)
VALUES
('capability-http-governance','tenant-http-a','site-http-a','source-http-a','asset-http-grant',
 'neoagro','ec','dS/m','measured','CI calibrated EC fixture',
 'manual-lab','1.0','interval',3600,31536000,300,'Africa/Tunis','[]',
 1,'profile-http-calibration','source-rights:ci-http-a-asset','source-evidence:ci-http-a-asset',1,'pending','ci-human-subject');
INSERT INTO source_capability_events
(id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
VALUES
('capability-http-governance-submitted','capability-http-governance','tenant-http-a','site-http-a','source-http-a',
 'ci-human-subject','submitted','fixture:capability-submission',NULL,'ci-capability-governance-submit');






-- Evidence and rights fixtures for the authenticated lifecycle routes. The
-- first document remains registered/pending review; the second is independently
-- verified and supports the pending rights declaration.
INSERT INTO audit_events
(id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,request_id,details_json)
VALUES
('audit-http-evidence-route-create','tenant-http-a','operator','ci-human-subject',
 'source_evidence.registered','source_evidence_document','source-evidence:ci-route-evidence',
 'req-http-evidence-route-create','{}'),
('audit-http-rights-evidence-create','tenant-http-a','operator','ci-human-subject',
 'source_evidence.registered','source_evidence_document','source-evidence:ci-rights-evidence',
 'req-http-rights-evidence-create','{}');

INSERT INTO source_evidence_documents
(id,tenant_id,site_id,source_id,document_type,file_name,media_type,byte_length,sha256,
 document_bytes,issuer_name,document_reference,issued_at,effective_from,effective_to,
 uploaded_by_subject,request_id)
VALUES
('source-evidence:ci-route-evidence','tenant-http-a','site-http-a','source-http-a',
 'data_license','route-evidence.pdf','application/pdf',5,'2222222222222222222222222222222222222222222222222222222222222222',X'255044462D',
 'CI route provider','CI-ROUTE-EVIDENCE','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',
 '2027-01-01T00:00:00Z','ci-human-subject','req-http-evidence-route-create'),
('source-evidence:ci-rights-evidence','tenant-http-a','site-http-a','source-http-a',
 'data_license','rights-evidence.pdf','application/pdf',5,'1111111111111111111111111111111111111111111111111111111111111111',X'255044462D',
 'CI rights provider','CI-RIGHTS-EVIDENCE','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',
 '2027-01-01T00:00:00Z','ci-human-subject','req-http-rights-evidence-create');

INSERT INTO audit_events
(id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,request_id,details_json)
VALUES
('audit-http-evidence-route-registered','tenant-http-a','operator','ci-human-subject',
 'source_evidence.registered','source_evidence_document','source-evidence:ci-route-evidence',
 'req-http-evidence-route-registered','{}'),
('audit-http-rights-evidence-registered','tenant-http-a','operator','ci-human-subject',
 'source_evidence.registered','source_evidence_document','source-evidence:ci-rights-evidence',
 'req-http-rights-evidence-registered','{}');

INSERT INTO source_evidence_events
(id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,request_id)
VALUES
('event-http-evidence-route-registered','source-evidence:ci-route-evidence','tenant-http-a',
 'site-http-a','source-http-a','ci-human-subject','registered','2222222222222222222222222222222222222222222222222222222222222222',
 'req-http-evidence-route-registered'),
('event-http-rights-evidence-registered','source-evidence:ci-rights-evidence','tenant-http-a',
 'site-http-a','source-http-a','ci-human-subject','registered','1111111111111111111111111111111111111111111111111111111111111111',
 'req-http-rights-evidence-registered');

INSERT INTO audit_events
(id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,request_id,details_json)
VALUES
('audit-http-rights-evidence-verified','tenant-http-a','operator','ci-measurement-reviewer',
 'source_evidence.verified','source_evidence_document','source-evidence:ci-rights-evidence',
 'req-http-rights-evidence-verified','{}');

INSERT INTO source_evidence_events
(id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,request_id)
VALUES
('event-http-rights-evidence-verified','source-evidence:ci-rights-evidence','tenant-http-a',
 'site-http-a','source-http-a','ci-measurement-reviewer','verified','1111111111111111111111111111111111111111111111111111111111111111',
 'req-http-rights-evidence-verified');

INSERT INTO audit_events
(id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,request_id,details_json)
VALUES
('audit-http-rights-declared','tenant-http-a','operator','ci-human-subject',
 'source_data_rights.declared','source_data_rights_declaration','source-rights:ci-route-rights',
 'req-http-rights-declared','{}');

INSERT INTO source_data_rights_declarations
(id,tenant_id,site_id,source_id,supporting_evidence_id,supporting_evidence_sha256,
 provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,
 restrictions_json,effective_from,effective_to,declaration_sha256,declared_by_subject,request_id)
VALUES
('source-rights:ci-route-rights','tenant-http-a','site-http-a','source-http-a',
 'source-evidence:ci-rights-evidence','1111111111111111111111111111111111111111111111111111111111111111',
 'CI rights provider','CI tenant controller','license','CI-ROUTE-RIGHTS',
 '["measurement_ingestion","analytics"]','[]','2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',
 lower(hex(zeroblob(32))),'ci-human-subject','req-http-rights-declared');

INSERT INTO audit_events
(id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,request_id,details_json)
VALUES
('audit-http-rights-event-declared','tenant-http-a','operator','ci-human-subject',
 'source_data_rights.declared','source_data_rights_declaration','source-rights:ci-route-rights',
 'req-http-rights-event-declared','{}');

INSERT INTO source_data_rights_events
(id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,
 reviewed_declaration_sha256,reviewed_evidence_sha256,request_id)
VALUES
('event-http-rights-declared','source-rights:ci-route-rights','tenant-http-a','site-http-a',
 'source-http-a','ci-human-subject','declared',lower(hex(zeroblob(32))),
 '1111111111111111111111111111111111111111111111111111111111111111','req-http-rights-event-declared');
