PRAGMA foreign_keys = ON;

-- Customer/site policies are explicit, versioned limits. No global or inferred tolerance.
CREATE TABLE measurement_quality_policies (
 id TEXT PRIMARY KEY CHECK(length(trim(id)) BETWEEN 1 AND 160),
 tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, asset_id TEXT NOT NULL,
 sensor_id TEXT NOT NULL, parameter TEXT NOT NULL, unit TEXT NOT NULL,
 version TEXT NOT NULL CHECK(length(trim(version)) BETWEEN 1 AND 80),
 minimum_value REAL, maximum_value REAL,
 effective_from TEXT NOT NULL, effective_to TEXT,
 method TEXT NOT NULL CHECK(length(trim(method)) BETWEEN 1 AND 160),
 evidence_ref TEXT NOT NULL CHECK(length(trim(evidence_ref)) BETWEEN 1 AND 500),
 registered_by_subject TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK(minimum_value IS NOT NULL OR maximum_value IS NOT NULL),
 CHECK(minimum_value IS NULL OR maximum_value IS NULL OR minimum_value <= maximum_value),
 CHECK(effective_to IS NULL OR effective_to > effective_from),
 UNIQUE(id,tenant_id,site_id,asset_id,sensor_id,parameter,unit),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 FOREIGN KEY(site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
 FOREIGN KEY(asset_id,tenant_id,site_id) REFERENCES assets(id,tenant_id,site_id) ON DELETE RESTRICT
);
CREATE INDEX idx_measurement_quality_policy_scope
 ON measurement_quality_policies(tenant_id,site_id,asset_id,sensor_id,parameter,unit,effective_from);

CREATE TABLE measurement_quality_policy_events (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, asset_id TEXT NOT NULL,
 policy_id TEXT NOT NULL, reviewer_subject TEXT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('verified','rejected','revoked')),
 evidence_ref TEXT NOT NULL, reason TEXT, request_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(policy_id,tenant_id,site_id,asset_id)
 REFERENCES measurement_quality_policies(id,tenant_id,site_id,asset_id) ON DELETE RESTRICT
);
CREATE INDEX idx_measurement_quality_policy_events
 ON measurement_quality_policy_events(tenant_id,policy_id,occurred_at,id);

CREATE TABLE measurement_quality_assessments (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL,
 observation_id TEXT NOT NULL, mapping_id TEXT, calibration_id TEXT, policy_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('passed','failed','not_assessed')),
 reason_code TEXT NOT NULL CHECK(length(trim(reason_code)) BETWEEN 1 AND 120),
 observed_value REAL, unit TEXT, assessed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 method_version TEXT NOT NULL, request_id TEXT NOT NULL,
 FOREIGN KEY(observation_id,tenant_id,site_id)
 REFERENCES observations(id,tenant_id,site_id) ON DELETE RESTRICT,
 FOREIGN KEY(mapping_id) REFERENCES sensor_source_identity_mappings(id) ON DELETE RESTRICT,
 FOREIGN KEY(calibration_id) REFERENCES sensor_calibrations(id) ON DELETE RESTRICT,
 FOREIGN KEY(policy_id) REFERENCES measurement_quality_policies(id) ON DELETE RESTRICT,
 UNIQUE(tenant_id,request_id)
);
CREATE INDEX idx_measurement_quality_assessments_observation
 ON measurement_quality_assessments(tenant_id,site_id,observation_id,assessed_at);

CREATE TRIGGER measurement_quality_policy_immutable_update
 BEFORE UPDATE ON measurement_quality_policies BEGIN SELECT RAISE(ABORT,'quality policies are immutable; register a new version'); END;
CREATE TRIGGER measurement_quality_policy_immutable_delete
 BEFORE DELETE ON measurement_quality_policies BEGIN SELECT RAISE(ABORT,'quality policies cannot be deleted'); END;
CREATE TRIGGER measurement_quality_policy_events_immutable_update
 BEFORE UPDATE ON measurement_quality_policy_events BEGIN SELECT RAISE(ABORT,'policy review events are immutable'); END;
CREATE TRIGGER measurement_quality_policy_events_immutable_delete
 BEFORE DELETE ON measurement_quality_policy_events BEGIN SELECT RAISE(ABORT,'policy review events cannot be deleted'); END;
CREATE TRIGGER measurement_quality_assessments_immutable_update
 BEFORE UPDATE ON measurement_quality_assessments BEGIN SELECT RAISE(ABORT,'quality assessments are immutable'); END;
CREATE TRIGGER measurement_quality_assessments_immutable_delete
 BEFORE DELETE ON measurement_quality_assessments BEGIN SELECT RAISE(ABORT,'quality assessments cannot be deleted'); END;

CREATE TRIGGER measurement_quality_policy_insert_guard BEFORE INSERT ON measurement_quality_policies
WHEN NOT EXISTS(
 SELECT 1 FROM tenants t JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id
 JOIN assets a ON a.id=NEW.asset_id AND a.tenant_id=NEW.tenant_id AND a.site_id=NEW.site_id
 WHERE t.id=NEW.tenant_id AND t.status='active'
)
BEGIN SELECT RAISE(ABORT,'quality policy requires active tenant and exact site asset scope'); END;

CREATE TRIGGER measurement_quality_policy_event_guard BEFORE INSERT ON measurement_quality_policy_events
WHEN NOT EXISTS(
 SELECT 1 FROM measurement_quality_policies p
 JOIN tenants t ON t.id=p.tenant_id AND t.status='active'
 JOIN observation_reviewers r ON r.tenant_id=p.tenant_id AND r.site_id=p.site_id
 WHERE p.id=NEW.policy_id AND p.tenant_id=NEW.tenant_id AND p.site_id=NEW.site_id AND p.asset_id=NEW.asset_id
 AND r.reviewer_subject=NEW.reviewer_subject AND r.reviewer_role='measurement_reviewer' AND r.status='active'
 AND p.registered_by_subject<>NEW.reviewer_subject
 AND ((NEW.event_type IN ('verified','rejected') AND NOT EXISTS(
   SELECT 1 FROM measurement_quality_policy_events e WHERE e.tenant_id=NEW.tenant_id AND e.policy_id=NEW.policy_id
 )) OR (NEW.event_type='revoked' AND (
   SELECT e.event_type FROM measurement_quality_policy_events e WHERE e.tenant_id=NEW.tenant_id
   AND e.policy_id=NEW.policy_id ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT 1
 )='verified'))
)
BEGIN SELECT RAISE(ABORT,'policy review requires independent active measurement reviewer and valid transition'); END;
