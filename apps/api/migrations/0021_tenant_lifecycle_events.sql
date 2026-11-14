-- NOVA Core tenant lifecycle audit and state guards — 0021
-- Tenant state changes are owner-authorized by the private Tenant API and
-- paired with an immutable event in the same D1 batch.

CREATE TABLE tenant_lifecycle_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (event_type IN ('suspended', 'reactivated', 'archived')),
  previous_status TEXT NOT NULL CHECK (previous_status IN ('active', 'suspended')),
  new_status TEXT NOT NULL CHECK (new_status IN ('active', 'suspended', 'archived')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CHECK (
    (event_type = 'suspended' AND previous_status = 'active' AND new_status = 'suspended')
    OR (event_type = 'reactivated' AND previous_status = 'suspended' AND new_status = 'active')
    OR (event_type = 'archived' AND previous_status IN ('active', 'suspended') AND new_status = 'archived')
  )
);

CREATE INDEX idx_tenant_lifecycle_events_timeline
  ON tenant_lifecycle_events(tenant_id, created_at DESC, id DESC);

CREATE TRIGGER tenant_lifecycle_event_prestate_guard
BEFORE INSERT ON tenant_lifecycle_events
WHEN NOT EXISTS (
  SELECT 1 FROM tenants t
  WHERE t.id = NEW.tenant_id AND t.status = NEW.previous_status
)
BEGIN
  SELECT RAISE(ABORT, 'tenant lifecycle event does not match tenant pre-state');
END;

CREATE TRIGGER tenant_lifecycle_update_requires_event
BEFORE UPDATE OF status ON tenants
WHEN NEW.status <> OLD.status
  AND NOT EXISTS (
    SELECT 1 FROM tenant_lifecycle_events e
    WHERE e.tenant_id = OLD.id
      AND e.previous_status = OLD.status
      AND e.new_status = NEW.status
      AND (
        (e.event_type = 'suspended' AND OLD.status = 'active' AND NEW.status = 'suspended')
        OR (e.event_type = 'reactivated' AND OLD.status = 'suspended' AND NEW.status = 'active')
        OR (e.event_type = 'archived' AND OLD.status IN ('active', 'suspended') AND NEW.status = 'archived')
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'tenant lifecycle update requires matching immutable event');
END;

CREATE TRIGGER tenant_lifecycle_archived_terminal
BEFORE UPDATE OF status ON tenants
WHEN OLD.status = 'archived' AND NEW.status <> 'archived'
BEGIN
  SELECT RAISE(ABORT, 'archived tenant state is terminal');
END;

CREATE TRIGGER tenant_lifecycle_events_no_update
BEFORE UPDATE ON tenant_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'tenant lifecycle events are append-only');
END;

CREATE TRIGGER tenant_lifecycle_events_no_delete
BEFORE DELETE ON tenant_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'tenant lifecycle events are append-only');
END;
