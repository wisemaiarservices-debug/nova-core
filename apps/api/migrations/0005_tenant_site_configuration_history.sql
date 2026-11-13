-- NOVA tenant-scoped immutable client configuration history — 0005
-- Apply only after 0002 tenant isolation, 0003 nonce replay protection and
-- 0004 ownership immutability. No tenant/site rows are created or backfilled.
PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX idx_sites_id_tenant_unique
  ON sites(id, tenant_id);

CREATE TABLE tenant_site_configurations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  configuration_version TEXT NOT NULL
    CHECK (configuration_version GLOB 'v[1-9]*'
      AND length(configuration_version) BETWEEN 2 AND 32),
  schema_id TEXT NOT NULL
    CHECK (length(trim(schema_id)) BETWEEN 1 AND 120),
  configuration_json TEXT NOT NULL
    CHECK (json_valid(configuration_json)
      AND json_type(configuration_json) = 'object'),
  content_sha256 TEXT NOT NULL
    CHECK (length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_by_subject TEXT NOT NULL
    CHECK (length(trim(created_by_subject)) BETWEEN 1 AND 200),
  request_id TEXT NOT NULL
    CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, site_id, configuration_version),
  UNIQUE (id, tenant_id, site_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_tenant_site_configurations_history
  ON tenant_site_configurations(tenant_id, site_id, created_at DESC);

CREATE TABLE tenant_site_configuration_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  configuration_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'submitted_for_review', 'approved_for_review', 'rejected',
    'withdrawn', 'superseded'
  )),
  actor_subject TEXT NOT NULL
    CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
  request_id TEXT NOT NULL
    CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (configuration_id, tenant_id, site_id)
    REFERENCES tenant_site_configurations(id, tenant_id, site_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_tenant_site_configuration_events_history
  ON tenant_site_configuration_events(tenant_id, site_id, occurred_at DESC);

CREATE TRIGGER tenant_site_configurations_active_tenant_insert_guard
BEFORE INSERT ON tenant_site_configurations
WHEN NOT EXISTS (
  SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'configuration write requires an active tenant');
END;

CREATE TRIGGER tenant_site_configurations_immutable_update_guard
BEFORE UPDATE ON tenant_site_configurations
BEGIN
  SELECT RAISE(ABORT, 'configuration versions are immutable; create a new version');
END;

CREATE TRIGGER tenant_site_configurations_immutable_delete_guard
BEFORE DELETE ON tenant_site_configurations
BEGIN
  SELECT RAISE(ABORT, 'configuration history cannot be deleted');
END;

CREATE TRIGGER tenant_site_configuration_events_active_tenant_insert_guard
BEFORE INSERT ON tenant_site_configuration_events
WHEN NOT EXISTS (
  SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'configuration event requires an active tenant');
END;

CREATE TRIGGER tenant_site_configuration_events_immutable_update_guard
BEFORE UPDATE ON tenant_site_configuration_events
BEGIN
  SELECT RAISE(ABORT, 'configuration history events are immutable');
END;

CREATE TRIGGER tenant_site_configuration_events_immutable_delete_guard
BEFORE DELETE ON tenant_site_configuration_events
BEGIN
  SELECT RAISE(ABORT, 'configuration history events cannot be deleted');
END;
