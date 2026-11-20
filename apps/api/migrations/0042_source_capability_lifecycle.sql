-- Governed, versioned source capability lifecycle — 0042
-- Capabilities describe the measurements a verified source is allowed to submit.
-- A source verification decision does not itself approve any measurement capability.
-- This migration adds lifecycle storage and commit-time guards for capability
-- registration/review. Observation enforcement is deliberately introduced only
-- with the ingestion/fixture cutover so legacy fixture writes are not silently
-- grandfathered or broken by a partial rollout.

PRAGMA foreign_keys = ON;

CREATE TABLE source_capabilities (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  asset_id TEXT,
  module TEXT NOT NULL CHECK (module IN ('nova-core','neoagro','neogrid','neocell')),
  metric TEXT NOT NULL CHECK (
    length(trim(metric)) BETWEEN 1 AND 120
    AND metric GLOB '[a-z]*'
    AND metric NOT GLOB '*[^a-z0-9._-]*'
  ),
  unit TEXT NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 32
    AND instr(unit,' ')=0 AND instr(unit,char(9))=0
    AND instr(unit,char(10))=0 AND instr(unit,char(13))=0),
  measurement_kind TEXT NOT NULL CHECK (measurement_kind IN ('measured','derived')),
  quantity_semantics TEXT NOT NULL CHECK (length(trim(quantity_semantics)) BETWEEN 1 AND 500),
  acquisition_protocol TEXT NOT NULL CHECK (length(trim(acquisition_protocol)) BETWEEN 1 AND 80),
  protocol_version TEXT NOT NULL CHECK (length(trim(protocol_version)) BETWEEN 1 AND 80),
  sampling_mode TEXT NOT NULL CHECK (sampling_mode IN ('interval','event')),
  interval_seconds INTEGER,
  max_age_seconds INTEGER NOT NULL CHECK (max_age_seconds BETWEEN 1 AND 31536000),
  max_future_skew_seconds INTEGER NOT NULL CHECK (max_future_skew_seconds BETWEEN 0 AND 86400),
  timezone TEXT NOT NULL CHECK (length(trim(timezone)) BETWEEN 1 AND 80),
  allowed_quality_flags_json TEXT NOT NULL CHECK (
    json_valid(allowed_quality_flags_json)
    AND json_type(allowed_quality_flags_json) = 'array'
  ),
  calibration_required INTEGER NOT NULL CHECK (calibration_required IN (0,1)),
  calibration_profile_ref TEXT,
  data_rights_ref TEXT NOT NULL CHECK (length(trim(data_rights_ref)) BETWEEN 1 AND 500),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','revoked')),
  created_by_subject TEXT NOT NULL CHECK (length(trim(created_by_subject)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
  CHECK (
    (sampling_mode='interval' AND interval_seconds BETWEEN 1 AND 31536000
      AND max_age_seconds >= interval_seconds)
    OR (sampling_mode='event' AND interval_seconds IS NULL)
  ),
  CHECK (
    (calibration_required=1 AND calibration_profile_ref IS NOT NULL
      AND length(trim(calibration_profile_ref)) BETWEEN 1 AND 500)
    OR (calibration_required=0 AND
      (calibration_profile_ref IS NULL OR length(trim(calibration_profile_ref)) BETWEEN 1 AND 500))
  )
);

CREATE UNIQUE INDEX source_capabilities_version_scope_unique
  ON source_capabilities(tenant_id, site_id, source_id, COALESCE(asset_id,''), module, metric, unit, version);
CREATE INDEX source_capabilities_active_lookup
  ON source_capabilities(tenant_id, site_id, source_id, status, module, metric, unit);

CREATE TABLE source_capability_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  capability_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted','approved','rejected','revoked')),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  reason TEXT,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (capability_id) REFERENCES source_capabilities(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT,
  CHECK (
    (event_type IN ('submitted','approved') AND reason IS NULL)
    OR (event_type IN ('rejected','revoked') AND length(trim(reason)) BETWEEN 1 AND 2000)
  )
);
CREATE UNIQUE INDEX source_capability_event_once
  ON source_capability_events(capability_id, event_type);
CREATE INDEX source_capability_events_timeline
  ON source_capability_events(tenant_id, capability_id, occurred_at DESC, id);
