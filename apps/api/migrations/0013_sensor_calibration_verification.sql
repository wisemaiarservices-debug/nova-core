PRAGMA foreign_keys = ON;
CREATE TABLE sensor_calibration_reviewers (
 tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, reviewer_subject TEXT NOT NULL,
 reviewer_role TEXT NOT NULL DEFAULT 'calibration_reviewer' CHECK(reviewer_role='calibration_reviewer'),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 assigned_by_subject TEXT NOT NULL, assignment_evidence_ref TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(tenant_id,site_id,reviewer_subject,reviewer_role),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE RESTRICT
);
CREATE TABLE sensor_calibration_reviewer_events (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, reviewer_subject TEXT NOT NULL,
 reviewer_role TEXT NOT NULL CHECK(reviewer_role='calibration_reviewer'),
 event_type TEXT NOT NULL CHECK(event_type IN ('assigned','revoked')),
 actor_subject TEXT NOT NULL, evidence_ref TEXT NOT NULL, reason TEXT, request_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE RESTRICT
);
CREATE TABLE sensor_calibration_verification_events (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, asset_id TEXT NOT NULL,
 calibration_id TEXT NOT NULL, reviewer_subject TEXT NOT NULL,
 reviewer_role TEXT NOT NULL CHECK(reviewer_role='calibration_reviewer'),
 event_type TEXT NOT NULL CHECK(event_type IN ('verified','rejected','revoked')),
 evidence_ref TEXT NOT NULL, reason TEXT, request_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(calibration_id,tenant_id,site_id,asset_id)
 REFERENCES sensor_calibrations(id,tenant_id,site_id,asset_id) ON DELETE RESTRICT
);
CREATE INDEX idx_sensor_calibration_reviewers_site ON sensor_calibration_reviewers(tenant_id,site_id,status,reviewer_subject);
CREATE INDEX idx_sensor_calibration_verification_history ON sensor_calibration_verification_events(tenant_id,site_id,calibration_id,occurred_at,id);
CREATE TRIGGER sensor_calibration_reviewer_events_immutable_update BEFORE UPDATE ON sensor_calibration_reviewer_events BEGIN SELECT RAISE(ABORT,'reviewer events are immutable'); END;
CREATE TRIGGER sensor_calibration_reviewer_events_immutable_delete BEFORE DELETE ON sensor_calibration_reviewer_events BEGIN SELECT RAISE(ABORT,'reviewer events cannot be deleted'); END;
CREATE TRIGGER sensor_calibration_verification_events_immutable_update BEFORE UPDATE ON sensor_calibration_verification_events BEGIN SELECT RAISE(ABORT,'verification events are immutable'); END;
CREATE TRIGGER sensor_calibration_verification_events_immutable_delete BEFORE DELETE ON sensor_calibration_verification_events BEGIN SELECT RAISE(ABORT,'verification events cannot be deleted'); END;
CREATE TRIGGER sensor_calibration_reviewer_assignment_guard BEFORE INSERT ON sensor_calibration_reviewers
WHEN NOT EXISTS(SELECT 1 FROM tenants t JOIN sites s ON s.id=NEW.site_id WHERE t.id=NEW.tenant_id AND t.status='active')
BEGIN SELECT RAISE(ABORT,'reviewer assignment tenant and site must be active and scoped'); END;
CREATE TRIGGER sensor_calibration_reviewer_event_guard BEFORE INSERT ON sensor_calibration_reviewer_events
WHEN NOT EXISTS(SELECT 1 FROM tenants t JOIN sites s ON s.id=NEW.site_id WHERE t.id=NEW.tenant_id AND t.status='active')
BEGIN SELECT RAISE(ABORT,'reviewer event tenant and site must be active and scoped'); END;
CREATE TRIGGER sensor_calibration_verification_guard BEFORE INSERT ON sensor_calibration_verification_events
WHEN NOT EXISTS(
 SELECT 1 FROM sensor_calibrations c
 JOIN sensor_calibration_reviewers r ON r.tenant_id=c.tenant_id AND r.site_id=c.site_id
 JOIN tenants t ON t.id=c.tenant_id AND t.status='active'
 WHERE c.id=NEW.calibration_id AND c.tenant_id=NEW.tenant_id AND c.site_id=NEW.site_id
 AND c.asset_id=NEW.asset_id AND r.reviewer_subject=NEW.reviewer_subject
 AND r.reviewer_role=NEW.reviewer_role AND r.status='active'
 AND c.registered_by_subject<>NEW.reviewer_subject
 AND (NEW.event_type<>'revoked' OR
   (SELECT e.event_type FROM sensor_calibration_verification_events e
    WHERE e.tenant_id=NEW.tenant_id AND e.calibration_id=NEW.calibration_id
    ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT 1)='verified')
 AND (NEW.event_type='revoked' OR NOT EXISTS(
   SELECT 1 FROM sensor_calibration_verification_events e
   WHERE e.tenant_id=NEW.tenant_id AND e.calibration_id=NEW.calibration_id
 ))
)
BEGIN SELECT RAISE(ABORT,'calibration verification requires independent active reviewer and valid transition'); END;
