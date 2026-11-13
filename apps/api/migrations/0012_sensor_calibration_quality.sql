-- Sensor/source calibration records and independent human review history.
-- Calibration status is evidence governance, not automatic proof of measurement accuracy.
PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX idx_sources_id_tenant_site
  ON sources(id, tenant_id, site_id);

CREATE TABLE source_calibrations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  instrument_serial TEXT NOT NULL CHECK (length(trim(instrument_serial)) BETWEEN 1 AND 160),
  metric TEXT NOT NULL CHECK (length(trim(metric)) BETWEEN 1 AND 120),
  unit TEXT NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 48),
  calibration_method TEXT NOT NULL CHECK (calibration_method IN (
    'laboratory', 'field_comparison', 'manufacturer', 'reference_instrument', 'other'
  )),
  calibration_standard TEXT NOT NULL CHECK (length(trim(calibration_standard)) BETWEEN 1 AND 240),
  calibrated_at TEXT NOT NULL CHECK (length(calibrated_at) BETWEEN 20 AND 40),
  valid_until TEXT NOT NULL CHECK (length(valid_until) BETWEEN 20 AND 40),
  range_min REAL NOT NULL,
  range_max REAL NOT NULL,
  uncertainty REAL NOT NULL CHECK (uncertainty >= 0),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  created_by_subject TEXT NOT NULL CHECK (length(trim(created_by_subject)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'verified', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (range_min <= range_max),
  CHECK (valid_until > calibrated_at),
  UNIQUE (id, tenant_id, site_id, source_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id, tenant_id, site_id) REFERENCES sources(id, tenant_id, site_id) ON DELETE RESTRICT
);
CREATE INDEX idx_source_calibrations_observation_lookup
  ON source_calibrations(tenant_id, site_id, source_id, metric, unit, status, calibrated_at, valid_until);

CREATE TABLE source_calibration_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  calibration_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('registered', 'verified', 'rejected', 'revoked')),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  reviewer_role TEXT CHECK (reviewer_role IS NULL OR reviewer_role = 'measurement_reviewer'),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (calibration_id, tenant_id, site_id, source_id)
    REFERENCES source_calibrations(id, tenant_id, site_id, source_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_source_calibration_single_registration
  ON source_calibration_events(calibration_id) WHERE event_type = 'registered';
CREATE INDEX idx_source_calibration_events_history
  ON source_calibration_events(tenant_id, site_id, source_id, calibration_id, occurred_at);

CREATE TRIGGER source_calibration_active_tenant_guard
BEFORE INSERT ON source_calibrations
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN SELECT RAISE(ABORT, 'calibration requires an active tenant'); END;

CREATE TRIGGER source_calibration_source_scope_guard
BEFORE INSERT ON source_calibrations
WHEN NOT EXISTS (
  SELECT 1 FROM sources s
  WHERE s.id = NEW.source_id AND s.tenant_id = NEW.tenant_id
    AND s.site_id = NEW.site_id
)
BEGIN SELECT RAISE(ABORT, 'calibration source must match tenant and site'); END;

CREATE TRIGGER source_calibration_immutable_guard
BEFORE UPDATE OF tenant_id, site_id, source_id, instrument_serial, metric, unit,
  calibration_method, calibration_standard, calibrated_at, valid_until, range_min,
  range_max, uncertainty, evidence_ref, created_by_subject, created_at
ON source_calibrations
BEGIN SELECT RAISE(ABORT, 'calibration identity and evidence are immutable'); END;

CREATE TRIGGER source_calibration_delete_guard
BEFORE DELETE ON source_calibrations
BEGIN SELECT RAISE(ABORT, 'calibration records are retained; revoke instead'); END;

CREATE TRIGGER source_calibration_event_state_guard
BEFORE INSERT ON source_calibration_events
WHEN NOT EXISTS (
  SELECT 1 FROM source_calibrations c
  JOIN tenants t ON t.id = c.tenant_id AND t.status = 'active'
  WHERE c.id = NEW.calibration_id AND c.tenant_id = NEW.tenant_id
    AND c.site_id = NEW.site_id AND c.source_id = NEW.source_id
    AND (
      (NEW.event_type = 'registered' AND c.status = 'unverified'
        AND NEW.actor_subject = c.created_by_subject
        AND NEW.reviewer_role IS NULL
        AND NOT EXISTS (SELECT 1 FROM source_calibration_events e WHERE e.calibration_id = c.id))
      OR
      (NEW.event_type IN ('verified', 'rejected') AND c.status = 'unverified'
        AND NEW.reviewer_role = 'measurement_reviewer'
        AND NEW.actor_subject <> c.created_by_subject
        AND EXISTS (SELECT 1 FROM observation_reviewers r
          WHERE r.tenant_id = c.tenant_id AND r.site_id = c.site_id
            AND r.reviewer_subject = NEW.actor_subject
            AND r.reviewer_role = 'measurement_reviewer' AND r.status = 'active')
        AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = c.tenant_id
          AND m.subject = NEW.actor_subject AND m.status = 'active')
        AND (SELECT e.event_type FROM source_calibration_events e
          WHERE e.calibration_id = c.id ORDER BY e.rowid DESC LIMIT 1) IN ('registered', 'revoked'))
      OR
      (NEW.event_type = 'revoked' AND c.status = 'verified'
        AND NEW.reviewer_role = 'measurement_reviewer'
        AND NEW.actor_subject <> c.created_by_subject
        AND EXISTS (SELECT 1 FROM observation_reviewers r
          WHERE r.tenant_id = c.tenant_id AND r.site_id = c.site_id
            AND r.reviewer_subject = NEW.actor_subject
            AND r.reviewer_role = 'measurement_reviewer' AND r.status = 'active')
        AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = c.tenant_id
          AND m.subject = NEW.actor_subject AND m.status = 'active')
        AND (SELECT e.event_type FROM source_calibration_events e
          WHERE e.calibration_id = c.id ORDER BY e.rowid DESC LIMIT 1) = 'verified')
    )
)
BEGIN SELECT RAISE(ABORT, 'invalid calibration event or reviewer scope'); END;

CREATE TRIGGER source_calibration_status_guard
BEFORE UPDATE OF status ON source_calibrations
WHEN NEW.status IS NOT OLD.status
AND NOT EXISTS (
  SELECT 1 FROM source_calibration_events e
  WHERE e.calibration_id = OLD.id AND e.tenant_id = OLD.tenant_id
    AND e.site_id = OLD.site_id AND e.source_id = OLD.source_id
    AND e.event_type = CASE NEW.status
      WHEN 'verified' THEN 'verified'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'unverified' THEN 'revoked'
      ELSE ''
    END
    AND ((OLD.status = 'unverified' AND NEW.status IN ('verified', 'rejected'))
      OR (OLD.status = 'verified' AND NEW.status = 'unverified'))
  ORDER BY e.rowid DESC LIMIT 1
)
BEGIN SELECT RAISE(ABORT, 'calibration status requires a matching review event'); END;

CREATE TRIGGER source_calibration_events_immutable_update_guard
BEFORE UPDATE ON source_calibration_events
BEGIN SELECT RAISE(ABORT, 'calibration review history is immutable'); END;
CREATE TRIGGER source_calibration_events_immutable_delete_guard
BEFORE DELETE ON source_calibration_events
BEGIN SELECT RAISE(ABORT, 'calibration review history cannot be deleted'); END;
