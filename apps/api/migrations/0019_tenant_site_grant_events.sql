-- NOVA Core immutable tenant site-grant audit history — 0019
-- Site grant mutations are performed only by the private Tenant API. Grant
-- rows and their audit events are written/deleted in the same D1 batch.

CREATE TABLE tenant_site_grant_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL CHECK (length(trim(grant_id)) BETWEEN 1 AND 160),
  subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 200),
  site_id TEXT NOT NULL CHECK (length(trim(site_id)) BETWEEN 1 AND 160),
  grant_action TEXT NOT NULL CHECK (grant_action IN ('read', 'create', 'update', 'delete', 'ingest', 'manage_members')),
  event_type TEXT NOT NULL CHECK (event_type IN ('granted', 'revoked')),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
CREATE INDEX idx_tenant_site_grant_events_timeline
  ON tenant_site_grant_events(tenant_id, site_id, created_at DESC);
CREATE INDEX idx_tenant_site_grant_events_subject
  ON tenant_site_grant_events(tenant_id, subject, created_at DESC);

CREATE TRIGGER tenant_site_grant_event_state_guard
BEFORE INSERT ON tenant_site_grant_events
WHEN (
  NEW.event_type = 'granted' AND NOT EXISTS (
    SELECT 1 FROM tenant_resource_grants g
    WHERE g.id = NEW.grant_id AND g.tenant_id = NEW.tenant_id
      AND g.subject = NEW.subject AND g.resource_type = 'site'
      AND g.resource_id = NEW.site_id AND g.action = NEW.grant_action
  )
) OR (
  NEW.event_type = 'revoked' AND EXISTS (
    SELECT 1 FROM tenant_resource_grants g
    WHERE g.id = NEW.grant_id AND g.tenant_id = NEW.tenant_id
      AND g.subject = NEW.subject AND g.resource_type = 'site'
      AND g.resource_id = NEW.site_id AND g.action = NEW.grant_action
  )
)
BEGIN
  SELECT RAISE(ABORT, 'site grant event does not match grant state');
END;

CREATE TRIGGER tenant_site_grant_events_no_update
BEFORE UPDATE ON tenant_site_grant_events
BEGIN
  SELECT RAISE(ABORT, 'tenant site grant events are append-only');
END;

CREATE TRIGGER tenant_site_grant_events_no_delete
BEFORE DELETE ON tenant_site_grant_events
BEGIN
  SELECT RAISE(ABORT, 'tenant site grant events are append-only');
END;
