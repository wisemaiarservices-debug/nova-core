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
  unit TEXT NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 32\n    AND instr(unit,' ')=0 AND instr(unit,char(9))=0\n    AND instr(unit,char(10))=0 AND instr(unit,char(13))=0),
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
CREATE UNIQUE INDEX source_capability_event_once\n  ON source_capability_events(capability_id, event_type);\nCREATE INDEX source_capability_events_timeline
  ON source_capability_events(tenant_id, capability_id, occurred_at DESC, id);

CREATE TRIGGER source_capability_insert_guard
BEFORE INSERT ON source_capabilities
WHEN NEW.status <> 'pending'
  OR NOT EXISTS (
    SELECT 1 FROM sources src
    JOIN tenants t ON t.id=src.tenant_id AND t.status='active'
    JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
    WHERE src.id=NEW.source_id AND src.tenant_id=NEW.tenant_id
      AND src.site_id=NEW.site_id AND src.module=NEW.module
      AND (NEW.event_type='revoked' OR src.verification_status='verified')
  )
  OR NOT EXISTS (
    SELECT 1 FROM tenant_memberships m
    WHERE m.tenant_id=NEW.tenant_id AND m.subject=NEW.created_by_subject
      AND m.status='active'
  )
  OR (NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM assets a WHERE a.id=NEW.asset_id
      AND a.tenant_id=NEW.tenant_id AND a.site_id=NEW.site_id AND a.status='active'
  ))
  OR EXISTS (
    SELECT 1 FROM source_capabilities prior
    WHERE prior.tenant_id=NEW.tenant_id AND prior.site_id=NEW.site_id
      AND prior.source_id=NEW.source_id
      AND COALESCE(prior.asset_id,'')=COALESCE(NEW.asset_id,'')
      AND prior.module=NEW.module AND prior.metric=NEW.metric
      AND prior.unit=NEW.unit AND prior.version>=NEW.version
  )
BEGIN
  SELECT RAISE(ABORT, 'source capability requires verified source, active scope and a new pending version');
END;

CREATE TRIGGER source_capability_identity_immutable
BEFORE UPDATE OF id, tenant_id, site_id, source_id, asset_id, module, metric, unit,
  measurement_kind, quantity_semantics, acquisition_protocol, protocol_version,
  sampling_mode, interval_seconds, max_age_seconds, max_future_skew_seconds,
  timezone, allowed_quality_flags_json, calibration_required, calibration_profile_ref,
  data_rights_ref, evidence_ref, version, created_by_subject, created_at
ON source_capabilities
BEGIN
  SELECT RAISE(ABORT, 'source capability definition is immutable; create a new version');
END;

CREATE TRIGGER source_capability_status_guard
BEFORE UPDATE OF status ON source_capabilities
WHEN NOT (
  (OLD.status='pending' AND NEW.status='approved'
    AND EXISTS (SELECT 1 FROM source_capability_events e
      WHERE e.capability_id=OLD.id AND e.event_type='approved'))
  OR (OLD.status='pending' AND NEW.status='rejected'
    AND EXISTS (SELECT 1 FROM source_capability_events e
      WHERE e.capability_id=OLD.id AND e.event_type='rejected'))
  OR (OLD.status='approved' AND NEW.status='revoked'
    AND EXISTS (SELECT 1 FROM source_capability_events e
      WHERE e.capability_id=OLD.id AND e.event_type='revoked'))
)
BEGIN
  SELECT RAISE(ABORT, 'source capability status transition requires its matching review event');
END;

CREATE TRIGGER source_capability_no_delete
BEFORE DELETE ON source_capabilities
BEGIN
  SELECT RAISE(ABORT, 'source capabilities are retained');
END;

CREATE TRIGGER source_capability_event_guard
BEFORE INSERT ON source_capability_events
WHEN NOT EXISTS (
  SELECT 1 FROM source_capabilities c
  JOIN sources src ON src.id=c.source_id AND src.tenant_id=c.tenant_id
    AND src.site_id=c.site_id AND src.module=c.module
  JOIN tenants t ON t.id=c.tenant_id AND t.status='active'
  JOIN sites s ON s.id=c.site_id AND s.tenant_id=c.tenant_id AND s.status='active'
  WHERE c.id=NEW.capability_id AND c.tenant_id=NEW.tenant_id
    AND c.site_id=NEW.site_id AND c.source_id=NEW.source_id
    AND src.verification_status='verified'
)
OR (
  NEW.event_type='submitted' AND NOT EXISTS (
    SELECT 1 FROM source_capabilities c
    JOIN tenant_memberships m ON m.tenant_id=c.tenant_id
      AND m.subject=c.created_by_subject AND m.status='active'
    WHERE c.id=NEW.capability_id AND c.status='pending'
      AND c.created_by_subject=NEW.actor_subject
  )
)
OR (
  NEW.event_type IN ('approved','rejected','revoked') AND NOT EXISTS (
    SELECT 1 FROM source_capabilities c
    JOIN tenant_source_reviewers r ON r.tenant_id=c.tenant_id
      AND r.site_id=c.site_id AND r.reviewer_subject=NEW.actor_subject
      AND r.status='active'
    JOIN tenant_memberships m ON m.tenant_id=r.tenant_id
      AND m.subject=r.reviewer_subject AND m.status='active'
    WHERE c.id=NEW.capability_id
      AND c.created_by_subject<>NEW.actor_subject
      AND (
        (NEW.event_type IN ('approved','rejected') AND c.status='pending'
          AND EXISTS (SELECT 1 FROM source_capability_events submitted
            WHERE submitted.capability_id=c.id AND submitted.event_type='submitted'))
        OR (NEW.event_type='revoked' AND c.status='approved')
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'source capability event violates scope, reviewer authority or lifecycle');
END;

CREATE TRIGGER source_capability_event_apply_status
AFTER INSERT ON source_capability_events
WHEN NEW.event_type IN ('approved','rejected','revoked')
BEGIN
  UPDATE source_capabilities
  SET status=CASE NEW.event_type
    WHEN 'approved' THEN 'approved'
    WHEN 'rejected' THEN 'rejected'
    ELSE 'revoked'
  END
  WHERE id=NEW.capability_id AND tenant_id=NEW.tenant_id
    AND site_id=NEW.site_id AND source_id=NEW.source_id;
END;

CREATE TRIGGER source_capability_events_immutable_update
BEFORE UPDATE ON source_capability_events
BEGIN
  SELECT RAISE(ABORT, 'source capability events are immutable');
END;
CREATE TRIGGER source_capability_events_immutable_delete
BEFORE DELETE ON source_capability_events
BEGIN
  SELECT RAISE(ABORT, 'source capability events cannot be deleted');
END;
