-- Controlled first-site creation, immutable audit and idempotent retry — 0022

CREATE TABLE tenant_site_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'created'),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE RESTRICT
);
CREATE INDEX idx_tenant_site_events_timeline
  ON tenant_site_events(tenant_id, site_id, created_at DESC);

CREATE TABLE tenant_site_creation_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  site_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, actor_subject, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE RESTRICT
);
CREATE INDEX idx_tenant_site_creation_requests_tenant
  ON tenant_site_creation_requests(tenant_id, created_at DESC);

CREATE TRIGGER tenant_site_events_insert_guard
BEFORE INSERT ON tenant_site_events
WHEN NOT EXISTS (
  SELECT 1 FROM sites s
  JOIN tenants t ON t.id = s.tenant_id AND t.status = 'active'
  JOIN tenant_memberships m ON m.tenant_id = s.tenant_id
    AND m.subject = NEW.actor_subject AND m.role = 'tenant_owner' AND m.status = 'active'
  JOIN tenant_resource_grants g ON g.tenant_id = s.tenant_id
    AND g.subject = NEW.actor_subject AND g.resource_type = 'site'
    AND g.resource_id = s.id AND g.action = 'read'
  JOIN tenant_site_grant_events ge ON ge.tenant_id = s.tenant_id
    AND ge.site_id = s.id AND ge.subject = NEW.actor_subject
    AND ge.grant_action = 'read' AND ge.event_type = 'granted'
  WHERE s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id
    AND s.status = 'active' AND NEW.event_type = 'created'
)
BEGIN
  SELECT RAISE(ABORT, 'site creation event requires active owner, site and initial read grant');
END;

CREATE TRIGGER tenant_site_events_no_update
BEFORE UPDATE ON tenant_site_events
BEGIN
  SELECT RAISE(ABORT, 'tenant site events are append-only');
END;
CREATE TRIGGER tenant_site_events_no_delete
BEFORE DELETE ON tenant_site_events
BEGIN
  SELECT RAISE(ABORT, 'tenant site events are append-only');
END;

CREATE TRIGGER tenant_site_creation_request_insert_guard
BEFORE INSERT ON tenant_site_creation_requests
WHEN NOT EXISTS (
  SELECT 1 FROM sites s
  JOIN tenants t ON t.id = s.tenant_id AND t.status = 'active'
  JOIN tenant_memberships m ON m.tenant_id = s.tenant_id
    AND m.subject = NEW.actor_subject AND m.role = 'tenant_owner' AND m.status = 'active'
  JOIN tenant_resource_grants g ON g.tenant_id = s.tenant_id
    AND g.subject = NEW.actor_subject AND g.resource_type = 'site'
    AND g.resource_id = s.id AND g.action = 'read'
  JOIN tenant_site_events e ON e.tenant_id = s.tenant_id AND e.site_id = s.id
    AND e.actor_subject = NEW.actor_subject AND e.request_id = NEW.request_id
  WHERE s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id AND s.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'site creation request requires committed site, audit and owner read grant');
END;

CREATE TRIGGER tenant_site_creation_requests_no_update
BEFORE UPDATE ON tenant_site_creation_requests
BEGIN
  SELECT RAISE(ABORT, 'tenant site creation requests are immutable');
END;
CREATE TRIGGER tenant_site_creation_requests_no_delete
BEFORE DELETE ON tenant_site_creation_requests
BEGIN
  SELECT RAISE(ABORT, 'tenant site creation requests are immutable');
END;
