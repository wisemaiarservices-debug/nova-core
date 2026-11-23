-- Immutable bridge from an approved capability calibration profile reference
-- to a reviewed source-to-sensor identity mapping. Calibration validity remains
-- determined by sensor_calibration_verification_events at observation commit.
PRAGMA foreign_keys = ON;

CREATE TABLE source_calibration_profiles (
  profile_ref TEXT PRIMARY KEY CHECK (length(trim(profile_ref)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  mapping_id TEXT NOT NULL,
  parameter TEXT NOT NULL CHECK (length(trim(parameter)) BETWEEN 1 AND 120),
  unit TEXT NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 48),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  created_by_subject TEXT NOT NULL CHECK (length(trim(created_by_subject)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id,tenant_id,site_id) REFERENCES assets(id,tenant_id,site_id) ON DELETE RESTRICT,
  FOREIGN KEY (mapping_id,tenant_id,site_id,asset_id,source_id)
    REFERENCES sensor_source_identity_mappings(id,tenant_id,site_id,asset_id,source_id)
    ON DELETE RESTRICT
);

CREATE INDEX source_calibration_profiles_scope_lookup
  ON source_calibration_profiles(tenant_id,site_id,source_id,asset_id,parameter,unit);

CREATE TRIGGER source_calibration_profile_insert_guard
BEFORE INSERT ON source_calibration_profiles
WHEN NOT EXISTS (
  SELECT 1
  FROM sensor_source_identity_mappings m
  JOIN sources src ON src.id=m.source_id
    AND src.tenant_id=m.tenant_id
    AND src.verification_status='verified'
  JOIN tenants t ON t.id=m.tenant_id AND t.status='active'
  JOIN sites s ON s.id=m.site_id AND s.tenant_id=m.tenant_id AND s.status='active'
  JOIN assets a ON a.id=m.asset_id AND a.tenant_id=m.tenant_id
    AND a.site_id=m.site_id AND a.status='active'
  JOIN tenant_memberships creator ON creator.tenant_id=m.tenant_id
    AND creator.subject=NEW.created_by_subject AND creator.status='active'
  WHERE m.id=NEW.mapping_id
    AND m.tenant_id=NEW.tenant_id
    AND m.site_id=NEW.site_id
    AND m.asset_id=NEW.asset_id
    AND m.source_id=NEW.source_id
    AND m.parameter=NEW.parameter
    AND m.unit=NEW.unit
    AND (
      SELECT e.event_type
      FROM sensor_source_mapping_events e
      WHERE e.tenant_id=m.tenant_id AND e.mapping_id=m.id
      ORDER BY e.occurred_at DESC,e.rowid DESC
      LIMIT 1
    )='verified'
)
BEGIN
  SELECT RAISE(ABORT, 'calibration profile requires active scope, member and currently verified exact source mapping');
END;

CREATE TRIGGER source_calibration_profiles_immutable_update
BEFORE UPDATE ON source_calibration_profiles
BEGIN
  SELECT RAISE(ABORT, 'source calibration profiles are immutable');
END;

CREATE TRIGGER source_calibration_profiles_immutable_delete
BEFORE DELETE ON source_calibration_profiles
BEGIN
  SELECT RAISE(ABORT, 'source calibration profiles cannot be deleted');
END;
