-- Governed tenant asset registration — 0027
-- Asset records start unconfigured. Registration does not establish sensor identity,
-- calibration, source verification, service credentials or ingestion authorization.

PRAGMA foreign_keys = ON;

CREATE TABLE tenant_asset_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (event_type IN ('created')),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, tenant_id, site_id)
    REFERENCES assets(id, tenant_id, site_id) ON DELETE RESTRICT
);

CREATE INDEX idx_tenant_asset_events_timeline
  ON tenant_asset_events(tenant_id, site_id, asset_id, created_at DESC);

CREATE TRIGGER tenant_asset_event_insert_guard
BEFORE INSERT ON tenant_asset_events
WHEN NOT EXISTS (
  SELECT 1 FROM tenants t
  JOIN sites s ON s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id AND s.status = 'active'
  JOIN assets a ON a.id = NEW.asset_id AND a.tenant_id = NEW.tenant_id
    AND a.site_id = NEW.site_id AND a.status = 'unconfigured'
  JOIN tenant_memberships m ON m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.actor_subject AND m.role = 'tenant_owner' AND m.status = 'active'
  WHERE t.id = NEW.tenant_id AND t.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'asset creation event requires active owner and exact tenant site asset');
END;

CREATE TRIGGER tenant_asset_events_no_update
BEFORE UPDATE ON tenant_asset_events
BEGIN
  SELECT RAISE(ABORT, 'tenant asset events are append-only');
END;

CREATE TRIGGER tenant_asset_events_no_delete
BEFORE DELETE ON tenant_asset_events
BEGIN
  SELECT RAISE(ABORT, 'tenant asset events are append-only');
END;

CREATE TABLE tenant_asset_creation_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  asset_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, actor_subject, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, tenant_id, site_id)
    REFERENCES assets(id, tenant_id, site_id) ON DELETE RESTRICT
);

CREATE TRIGGER tenant_asset_creation_request_insert_guard
BEFORE INSERT ON tenant_asset_creation_requests
WHEN NOT EXISTS (
  SELECT 1 FROM tenants t
  JOIN sites s ON s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id AND s.status = 'active'
  JOIN tenant_memberships m ON m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.actor_subject AND m.role = 'tenant_owner' AND m.status = 'active'
  JOIN tenant_asset_events e ON e.tenant_id = NEW.tenant_id
    AND e.site_id = NEW.site_id AND e.asset_id = NEW.asset_id
    AND e.actor_subject = NEW.actor_subject AND e.request_id = NEW.request_id
  WHERE t.id = NEW.tenant_id AND t.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'asset creation idempotency record requires committed owner asset event');
END;

CREATE TRIGGER tenant_asset_creation_requests_no_update
BEFORE UPDATE ON tenant_asset_creation_requests
BEGIN
  SELECT RAISE(ABORT, 'tenant asset creation requests are immutable');
END;

CREATE TRIGGER tenant_asset_creation_requests_no_delete
BEFORE DELETE ON tenant_asset_creation_requests
BEGIN
  SELECT RAISE(ABORT, 'tenant asset creation requests are immutable');
END;
