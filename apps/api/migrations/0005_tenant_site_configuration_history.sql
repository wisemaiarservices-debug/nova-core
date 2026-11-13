-- NOVA tenant-scoped immutable client configuration history — 0005
-- Apply only after 0002 tenant isolation, 0003 nonce replay protection and
-- 0004 ownership immutability. No tenant/site rows are created or backfilled.
PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX idx_sites_id_tenant_unique ON sites(id, tenant_id);

CREATE TABLE tenant_site_configurations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  configuration_version TEXT NOT NULL CHECK (
    length(configuration_version) BETWEEN 2 AND 32
    AND substr(configuration_version, 1, 1) = 'v'
    AND substr(configuration_version, 2) NOT GLOB '*[^0-9]*'
    AND substr(configuration_version, 2, 1) BETWEEN '1' AND '9'
  ),
  schema_id TEXT NOT NULL CHECK (length(trim(schema_id)) BETWEEN 1 AND 120),
  configuration_json TEXT NOT NULL CHECK (
    json_valid(configuration_json) AND json_type(configuration_json) = 'object'
  ),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by_subject TEXT NOT NULL CHECK (length(trim(created_by_subject)) BETWEEN 1 AND 200),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
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
    'submitted_for_review', 'approved_for_review', 'rejected', 'withdrawn', 'superseded'
  )),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
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
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN SELECT RAISE(ABORT, 'configuration write requires an active tenant'); END;

-- Versions are contiguous per site: v1, v2, v3...; no gaps or re-use.
CREATE TRIGGER tenant_site_configurations_sequential_version_guard
BEFORE INSERT ON tenant_site_configurations
WHEN CAST(substr(NEW.configuration_version, 2) AS INTEGER) != (
  SELECT COALESCE(MAX(CAST(substr(configuration_version, 2) AS INTEGER)), 0) + 1
  FROM tenant_site_configurations
  WHERE tenant_id = NEW.tenant_id AND site_id = NEW.site_id
)
BEGIN SELECT RAISE(ABORT, 'configuration version must be the next sequential site version'); END;

CREATE TRIGGER tenant_site_configurations_immutable_update_guard
BEFORE UPDATE ON tenant_site_configurations
BEGIN SELECT RAISE(ABORT, 'configuration versions are immutable; create a new version'); END;
CREATE TRIGGER tenant_site_configurations_immutable_delete_guard
BEFORE DELETE ON tenant_site_configurations
BEGIN SELECT RAISE(ABORT, 'configuration history cannot be deleted'); END;

CREATE TRIGGER tenant_site_configuration_events_active_tenant_insert_guard
BEFORE INSERT ON tenant_site_configuration_events
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN SELECT RAISE(ABORT, 'configuration event requires an active tenant'); END;

-- Review lifecycle: submit once; then approve, reject or withdraw. Only an
-- approved-for-review version may later be marked superseded by a new version.
CREATE TRIGGER tenant_site_configuration_events_transition_guard
BEFORE INSERT ON tenant_site_configuration_events
WHEN
  (NEW.event_type = 'submitted_for_review' AND EXISTS (
    SELECT 1 FROM tenant_site_configuration_events e WHERE e.configuration_id = NEW.configuration_id
  ))
  OR
  (NEW.event_type IN ('approved_for_review', 'rejected', 'withdrawn') AND
    (SELECT e.event_type FROM tenant_site_configuration_events e
     WHERE e.configuration_id = NEW.configuration_id
     ORDER BY e.rowid DESC LIMIT 1) IS NOT 'submitted_for_review')
  OR
  (NEW.event_type = 'superseded' AND
    (SELECT e.event_type FROM tenant_site_configuration_events e
     WHERE e.configuration_id = NEW.configuration_id
     ORDER BY e.rowid DESC LIMIT 1) IS NOT 'approved_for_review')
BEGIN SELECT RAISE(ABORT, 'invalid configuration review state transition'); END;

CREATE TRIGGER tenant_site_configuration_events_immutable_update_guard
BEFORE UPDATE ON tenant_site_configuration_events
BEGIN SELECT RAISE(ABORT, 'configuration history events are immutable'); END;
CREATE TRIGGER tenant_site_configuration_events_immutable_delete_guard
BEFORE DELETE ON tenant_site_configuration_events
BEGIN SELECT RAISE(ABORT, 'configuration history events cannot be deleted'); END;
