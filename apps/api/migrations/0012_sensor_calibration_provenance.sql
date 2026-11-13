PRAGMA foreign_keys = ON;
CREATE TABLE sensor_calibrations (
 id TEXT PRIMARY KEY CHECK(length(trim(id)) BETWEEN 1 AND 160),
 tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, asset_id TEXT NOT NULL,
 sensor_id TEXT NOT NULL CHECK(length(trim(sensor_id)) BETWEEN 1 AND 160),
 parameter TEXT NOT NULL CHECK(length(trim(parameter)) BETWEEN 1 AND 120),
 unit TEXT NOT NULL CHECK(length(trim(unit)) BETWEEN 1 AND 40),
 calibration_method TEXT NOT NULL CHECK(length(trim(calibration_method)) BETWEEN 1 AND 160),
 calibrated_at TEXT NOT NULL, valid_until TEXT NOT NULL,
 laboratory_name TEXT, certificate_evidence_id TEXT,
 reference_value REAL, as_found_value REAL, as_left_value REAL, uncertainty REAL CHECK(uncertainty IS NULL OR uncertainty>=0),
 notes TEXT, verification_status TEXT NOT NULL DEFAULT 'registered_unverified' CHECK(verification_status='registered_unverified'),
 registered_by_subject TEXT NOT NULL CHECK(length(trim(registered_by_subject)) BETWEEN 1 AND 200),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(id,tenant_id,site_id,asset_id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 FOREIGN KEY(site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
 FOREIGN KEY(asset_id,tenant_id,site_id) REFERENCES assets(id,tenant_id,site_id) ON DELETE RESTRICT,
 FOREIGN KEY(certificate_evidence_id,tenant_id,site_id) REFERENCES laboratory_report_evidence(id,tenant_id,site_id) ON DELETE RESTRICT,
 CHECK(length(trim(valid_until))>0 AND length(trim(calibrated_at))>0)
);
CREATE INDEX idx_sensor_calibrations_asset_sensor_time ON sensor_calibrations(tenant_id,site_id,asset_id,sensor_id,calibrated_at DESC);
CREATE TABLE sensor_calibration_events (
 id TEXT PRIMARY KEY, calibration_id TEXT NOT NULL, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type='registered'),
 actor_subject TEXT NOT NULL, request_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(calibration_id),
 FOREIGN KEY(calibration_id,tenant_id,site_id) REFERENCES sensor_calibrations(id,tenant_id,site_id) ON DELETE RESTRICT
);
CREATE TRIGGER sensor_calibrations_immutable_update BEFORE UPDATE ON sensor_calibrations BEGIN SELECT RAISE(ABORT,'sensor calibration records are immutable'); END;
CREATE TRIGGER sensor_calibrations_immutable_delete BEFORE DELETE ON sensor_calibrations BEGIN SELECT RAISE(ABORT,'sensor calibration records cannot be deleted'); END;
CREATE TRIGGER sensor_calibration_events_immutable_update BEFORE UPDATE ON sensor_calibration_events BEGIN SELECT RAISE(ABORT,'sensor calibration events are immutable'); END;
CREATE TRIGGER sensor_calibration_events_immutable_delete BEFORE DELETE ON sensor_calibration_events BEGIN SELECT RAISE(ABORT,'sensor calibration events cannot be deleted'); END;
CREATE TRIGGER sensor_calibration_event_guard BEFORE INSERT ON sensor_calibration_events
WHEN NOT EXISTS(SELECT 1 FROM sensor_calibrations c JOIN tenants t ON t.id=c.tenant_id AND t.status='active'
 WHERE c.id=NEW.calibration_id AND c.tenant_id=NEW.tenant_id AND c.site_id=NEW.site_id
 AND c.registered_by_subject=NEW.actor_subject AND c.verification_status='registered_unverified')
BEGIN SELECT RAISE(ABORT,'sensor calibration event must match its persisted record'); END;
