-- NOVA Core tenant isolation — 0002
-- Apply only after reviewing existing rows and assigning each legacy row to an
-- approved tenant. This migration does not create a tenant or assign ownership.
-- Rows left with NULL tenant_id must remain inaccessible to tenant-scoped APIs.

PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 120),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tenant_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 200),
  role TEXT NOT NULL CHECK (role IN ('tenant_owner', 'tenant_admin', 'operator', 'analyst', 'viewer', 'service')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, subject),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
CREATE INDEX idx_tenant_memberships_subject_status
  ON tenant_memberships(subject, status, tenant_id);

CREATE TABLE tenant_resource_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 200),
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'tenant', 'site', 'asset', 'source', 'observation',
    'experiment', 'dataset_snapshot', 'audit_event', 'membership'
  )),
  resource_id TEXT NOT NULL CHECK (
    length(trim(resource_id)) BETWEEN 1 AND 160
    AND instr(resource_id, '*') = 0
    AND instr(resource_id, '?') = 0
  ),
  action TEXT NOT NULL CHECK (action IN ('read', 'create', 'update', 'delete', 'ingest', 'manage_members')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, subject, resource_type, resource_id, action),
  CHECK (resource_type <> 'tenant' OR resource_id = tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
CREATE INDEX idx_tenant_resource_grants_lookup
  ON tenant_resource_grants(tenant_id, subject, resource_type, resource_id);

ALTER TABLE sites ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE assets ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE sources ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE observations ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE audit_events ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE INDEX idx_sites_tenant_status ON sites(tenant_id, status);
CREATE INDEX idx_assets_tenant_site ON assets(tenant_id, site_id, status);
CREATE INDEX idx_sources_tenant_site ON sources(tenant_id, site_id, module);
CREATE INDEX idx_observations_tenant_site_metric_time
  ON observations(tenant_id, site_id, metric, observed_at DESC);
CREATE INDEX idx_observations_tenant_source_time
  ON observations(tenant_id, source_id, observed_at DESC);
CREATE INDEX idx_audit_events_tenant_time
  ON audit_events(tenant_id, occurred_at DESC);

-- New or modified site records must always belong to an active tenant.
CREATE TRIGGER sites_tenant_insert_guard
BEFORE INSERT ON sites
WHEN NEW.tenant_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'site requires an active tenant');
END;

CREATE TRIGGER sites_tenant_update_guard
BEFORE UPDATE OF tenant_id ON sites
WHEN NEW.tenant_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'site requires an active tenant');
END;

CREATE TRIGGER assets_tenant_insert_guard
BEFORE INSERT ON assets
WHEN NEW.tenant_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM sites s WHERE s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'asset tenant must match its site');
END;

CREATE TRIGGER assets_tenant_update_guard
BEFORE UPDATE OF tenant_id, site_id ON assets
WHEN NEW.tenant_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM sites s WHERE s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'asset tenant must match its site');
END;

CREATE TRIGGER sources_tenant_insert_guard
BEFORE INSERT ON sources
WHEN NEW.tenant_id IS NULL OR (
  NEW.site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sites s WHERE s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'source requires a tenant matching its optional site');
END;

CREATE TRIGGER sources_tenant_update_guard
BEFORE UPDATE OF tenant_id, site_id ON sources
WHEN NEW.tenant_id IS NULL OR (
  NEW.site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sites s WHERE s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'source requires a tenant matching its optional site');
END;

CREATE TRIGGER observations_tenant_insert_guard
BEFORE INSERT ON observations
WHEN NEW.tenant_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id)
  OR NOT EXISTS (SELECT 1 FROM sources src WHERE src.id = NEW.source_id AND src.tenant_id = NEW.tenant_id)
  OR (NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = NEW.asset_id AND a.site_id = NEW.site_id AND a.tenant_id = NEW.tenant_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'observation site, source and asset must share one tenant');
END;

CREATE TRIGGER observations_tenant_update_guard
BEFORE UPDATE OF tenant_id, site_id, source_id, asset_id ON observations
WHEN NEW.tenant_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id)
  OR NOT EXISTS (SELECT 1 FROM sources src WHERE src.id = NEW.source_id AND src.tenant_id = NEW.tenant_id)
  OR (NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = NEW.asset_id AND a.site_id = NEW.site_id AND a.tenant_id = NEW.tenant_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'observation site, source and asset must share one tenant');
END;

CREATE TRIGGER audit_events_tenant_insert_guard
BEFORE INSERT ON audit_events
WHEN NEW.tenant_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'audit event tenant does not exist');
END;

CREATE TRIGGER audit_events_tenant_update_guard
BEFORE UPDATE OF tenant_id ON audit_events
WHEN NEW.tenant_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'audit event tenant does not exist');
END;


-- Suspension blocks new membership, grants and tenant-owned writes without
-- deleting records or rewriting historical ownership.
CREATE TRIGGER tenant_memberships_active_insert_guard
BEFORE INSERT ON tenant_memberships
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'membership requires an active tenant');
END;

CREATE TRIGGER tenant_memberships_active_update_guard
BEFORE UPDATE ON tenant_memberships
WHEN NEW.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'membership requires an active tenant');
END;

CREATE TRIGGER tenant_resource_grants_active_insert_guard
BEFORE INSERT ON tenant_resource_grants
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'resource grant requires an active tenant');
END;

CREATE TRIGGER tenant_resource_grants_active_update_guard
BEFORE UPDATE ON tenant_resource_grants
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'resource grant requires an active tenant');
END;

CREATE TRIGGER assets_active_tenant_insert_guard
BEFORE INSERT ON assets
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'asset write requires an active tenant');
END;

CREATE TRIGGER assets_active_tenant_update_guard
BEFORE UPDATE ON assets
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'asset write requires an active tenant');
END;

CREATE TRIGGER sources_active_tenant_insert_guard
BEFORE INSERT ON sources
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'source write requires an active tenant');
END;

CREATE TRIGGER sources_active_tenant_update_guard
BEFORE UPDATE ON sources
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'source write requires an active tenant');
END;

CREATE TRIGGER observations_active_tenant_insert_guard
BEFORE INSERT ON observations
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'observation write requires an active tenant');
END;

CREATE TRIGGER observations_active_tenant_update_guard
BEFORE UPDATE ON observations
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'observation write requires an active tenant');
END;


CREATE TRIGGER sites_active_tenant_update_guard
BEFORE UPDATE ON sites
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'site write requires an active tenant');
END;
