PRAGMA foreign_keys = ON;

-- Explicit, site-scoped identity bridge. It does not infer sensor identity from
-- source IDs; a reviewed mapping is required before observations can be assessed.
CREATE TABLE sensor_source_identity_mappings (
 id TEXT PRIMARY KEY CHECK(length(trim(id)) BETWEEN 1 AND 160),
 tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, asset_id TEXT NOT NULL,
 source_id TEXT NOT NULL, sensor_id TEXT NOT NULL,
 parameter TEXT NOT NULL, unit TEXT NOT NULL,
 effective_from TEXT NOT NULL, effective_to TEXT,
 mapping_method TEXT NOT NULL CHECK(length(trim(mapping_method)) BETWEEN 1 AND 160),
 evidence_ref TEXT NOT NULL CHECK(length(trim(evidence_ref)) BETWEEN 1 AND 500),
 registered_by_subject TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK(length(trim(sensor_id)) BETWEEN 1 AND 160),
 CHECK(length(trim(parameter)) BETWEEN 1 AND 120),
 CHECK(length(trim(unit)) BETWEEN 1 AND 48),
 CHECK(effective_to IS NULL OR effective_to > effective_from),
 UNIQUE(id,tenant_id,site_id,asset_id,source_id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 FOREIGN KEY(site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
 FOREIGN KEY(asset_id,tenant_id,site_id) REFERENCES assets(id,tenant_id,site_id) ON DELETE RESTRICT,
 FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE RESTRICT
);
CREATE INDEX idx_sensor_source_mapping_lookup
 ON sensor_source_identity_mappings(tenant_id,site_id,asset_id,source_id,parameter,unit,effective_from);

CREATE TABLE sensor_source_mapping_reviewers (
 tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, reviewer_subject TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 assigned_by_subject TEXT NOT NULL, evidence_ref TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(tenant_id,site_id,reviewer_subject),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 FOREIGN KEY(site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT
);
CREATE TABLE sensor_source_mapping_events (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, asset_id TEXT NOT NULL,
 source_id TEXT NOT NULL, mapping_id TEXT NOT NULL, reviewer_subject TEXT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('verified','rejected','revoked')),
 evidence_ref TEXT NOT NULL, reason TEXT, request_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(mapping_id,tenant_id,site_id,asset_id,source_id)
 REFERENCES sensor_source_identity_mappings(id,tenant_id,site_id,asset_id,source_id) ON DELETE RESTRICT
);
CREATE INDEX idx_sensor_source_mapping_events
 ON sensor_source_mapping_events(tenant_id,mapping_id,occurred_at,id);

CREATE TRIGGER sensor_source_mapping_immutable_update BEFORE UPDATE ON sensor_source_identity_mappings
 BEGIN SELECT RAISE(ABORT,'sensor source identity mappings are immutable'); END;
CREATE TRIGGER sensor_source_mapping_immutable_delete BEFORE DELETE ON sensor_source_identity_mappings
 BEGIN SELECT RAISE(ABORT,'sensor source identity mappings cannot be deleted'); END;
CREATE TRIGGER sensor_source_mapping_events_immutable_update BEFORE UPDATE ON sensor_source_mapping_events
 BEGIN SELECT RAISE(ABORT,'sensor source mapping events are immutable'); END;
CREATE TRIGGER sensor_source_mapping_events_immutable_delete BEFORE DELETE ON sensor_source_mapping_events
 BEGIN SELECT RAISE(ABORT,'sensor source mapping events cannot be deleted'); END;

CREATE TRIGGER sensor_source_mapping_insert_guard BEFORE INSERT ON sensor_source_identity_mappings
WHEN NOT EXISTS (
 SELECT 1 FROM tenants t JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id
 JOIN assets a ON a.id=NEW.asset_id AND a.tenant_id=NEW.tenant_id AND a.site_id=NEW.site_id AND a.status='active'
 JOIN sources src ON src.id=NEW.source_id AND src.tenant_id=NEW.tenant_id
 WHERE t.id=NEW.tenant_id AND t.status='active'
 AND (src.site_id IS NULL OR src.site_id=NEW.site_id)
)
BEGIN SELECT RAISE(ABORT,'sensor source mapping scope must match active tenant, site, asset and source'); END;

CREATE TRIGGER sensor_source_mapping_event_guard BEFORE INSERT ON sensor_source_mapping_events
WHEN NOT EXISTS (
 SELECT 1 FROM sensor_source_identity_mappings m
 JOIN tenants t ON t.id=m.tenant_id AND t.status='active'
 JOIN sensor_source_mapping_reviewers r ON r.tenant_id=m.tenant_id AND r.site_id=m.site_id
 WHERE m.id=NEW.mapping_id AND m.tenant_id=NEW.tenant_id AND m.site_id=NEW.site_id
 AND m.asset_id=NEW.asset_id AND m.source_id=NEW.source_id
 AND r.reviewer_subject=NEW.reviewer_subject AND r.status='active'
 AND m.registered_by_subject<>NEW.reviewer_subject
 AND (
  (NEW.event_type IN ('verified','rejected') AND NOT EXISTS(
   SELECT 1 FROM sensor_source_mapping_events e WHERE e.tenant_id=NEW.tenant_id AND e.mapping_id=NEW.mapping_id
  )) OR
  (NEW.event_type='revoked' AND (
   SELECT e.event_type FROM sensor_source_mapping_events e
   WHERE e.tenant_id=NEW.tenant_id AND e.mapping_id=NEW.mapping_id
   ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT 1
  )='verified')
 )
)
BEGIN SELECT RAISE(ABORT,'sensor source mapping review requires independent active reviewer and valid transition'); END;
