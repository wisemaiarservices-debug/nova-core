-- Apply only after the synthetic evidence/rights fixture helper has seeded exact scoped records.
-- Approval and observation rows are deliberately deferred until migration 0064 prerequisites exist.

INSERT INTO source_capability_events
(id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
VALUES
('capability-http-a-approved','capability-http-a','tenant-http-a','site-http-a','source-http-a',
 'ci-measurement-reviewer','approved','fixture:capability-review',NULL,'ci-capability-approve');

INSERT INTO source_capability_events
(id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
VALUES
('capability-http-grant-approved','capability-http-grant','tenant-http-a','site-http-a','source-http-grant',
 'ci-measurement-reviewer','approved','fixture:capability-review',NULL,'ci-capability-grant-approve');

INSERT INTO source_capability_events
(id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
VALUES
('capability-http-governance-approved','capability-http-governance','tenant-http-a','site-http-a','source-http-a',
 'ci-measurement-reviewer','approved','fixture:capability-review',NULL,'ci-capability-governance-approve');

INSERT INTO observations
(id, site_id, tenant_id, source_id, module, metric, value, unit, observed_at,
 idempotency_key, verification_status, provenance_json, quality_flags_json, source_capability_id, measurement_kind, acquisition_protocol, protocol_version, sampling_mode, sampling_interval_seconds)
VALUES
('obs-http-source-revocation', 'site-http-a', 'tenant-http-a', 'source-http-a', 'neoagro',
 'ec', 1.5, 'dS/m', '2026-05-10T10:00:00Z', 'ci-source-revocation-observation',
 'verified', '{"provider":"CI fixture provider","acquisition_method":"manual"}', '[]',
 'capability-http-a','measured','manual-lab','1.0','interval',3600);

INSERT INTO observations
(id, site_id, tenant_id, source_id, module, metric, value, unit, observed_at,
 idempotency_key, verification_status, provenance_json, quality_flags_json, source_capability_id, measurement_kind, acquisition_protocol, protocol_version, sampling_mode, sampling_interval_seconds)
VALUES
('obs-http-verified', 'site-http-a', 'tenant-http-a', 'source-http-a', 'neoagro',
 'ec', 1.5, 'dS/m', '2026-05-10T10:00:00Z', 'ci-observation-1', 'unverified',
 '{"provider":"CI fixture provider","acquisition_method":"manual"}', '[]',
 'capability-http-a','measured','manual-lab','1.0','interval',3600);

INSERT INTO observations
(id, site_id, tenant_id, asset_id, source_id, module, metric, value, unit, observed_at,
 idempotency_key, verification_status, provenance_json, quality_flags_json, source_capability_id, measurement_kind, acquisition_protocol, protocol_version, sampling_mode, sampling_interval_seconds)
VALUES
('obs-http-grant', 'site-http-a', 'tenant-http-a', 'asset-http-grant', 'source-http-grant',
 'neoagro', 'soil_moisture', 0.24, 'm3/m3', '2026-11-13T10:00:00Z',
 'ci-resource-grant-observation', 'unverified', '{}', '[]',
 'capability-http-grant','measured','manual-lab','1.0','interval',3600);

INSERT INTO observations
(id,site_id,tenant_id,asset_id,source_id,module,metric,value,unit,observed_at,idempotency_key,
 verification_status,provenance_json,quality_flags_json,source_capability_id,measurement_kind,acquisition_protocol,protocol_version,sampling_mode,sampling_interval_seconds)
VALUES
('obs-http-governance-revocation','site-http-a','tenant-http-a','asset-http-grant','source-http-a',
 'neoagro','ec',1.5,'dS/m','2026-05-10T10:00:00Z','ci-governance-revocation-observation',
 'verified','{"provider":"CI fixture provider","acquisition_method":"manual"}','[]',
 'capability-http-governance','measured','manual-lab','1.0','interval',3600);
