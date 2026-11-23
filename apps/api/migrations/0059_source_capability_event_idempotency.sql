-- Source capability lifecycle event idempotency — 0059
-- Records exact retries for submit/review/revoke events. Lifecycle state remains
-- controlled by source_capability_events and its D1 status-transition triggers.

PRAGMA foreign_keys = ON;

CREATE TABLE source_capability_event_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted','approved','rejected','revoked')),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, site_id, capability_id, actor_subject, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (capability_id) REFERENCES source_capabilities(id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id) REFERENCES source_capability_events(id) ON DELETE RESTRICT
);

CREATE INDEX idx_source_capability_event_requests_timeline
  ON source_capability_event_requests(tenant_id, site_id, capability_id, created_at DESC);

CREATE TRIGGER source_capability_event_request_insert_guard
BEFORE INSERT ON source_capability_event_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM source_capability_events e
  JOIN source_capabilities c ON c.id=e.capability_id
    AND c.tenant_id=e.tenant_id AND c.site_id=e.site_id
  JOIN tenants t ON t.id=NEW.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  JOIN tenant_memberships m ON m.tenant_id=NEW.tenant_id
    AND m.subject=NEW.actor_subject AND m.status='active'
  JOIN tenant_resource_grants g ON g.tenant_id=NEW.tenant_id
    AND g.subject=NEW.actor_subject AND g.resource_type='site'
    AND g.resource_id=NEW.site_id AND g.action='read'
  JOIN audit_events a ON a.tenant_id=NEW.tenant_id
    AND a.actor_type='operator' AND a.actor_id=NEW.actor_subject
    AND a.action='source_capability.' || NEW.event_type
    AND a.entity_type='source_capability' AND a.entity_id=NEW.capability_id
    AND a.request_id=NEW.request_id
  WHERE e.id=NEW.event_id AND e.capability_id=NEW.capability_id
    AND e.tenant_id=NEW.tenant_id AND e.site_id=NEW.site_id
    AND e.actor_subject=NEW.actor_subject AND e.event_type=NEW.event_type
    AND e.request_id=NEW.request_id
    AND c.tenant_id=NEW.tenant_id AND c.site_id=NEW.site_id
)
BEGIN
  SELECT RAISE(ABORT, 'source capability event request requires matching governed event and audit');
END;

CREATE TRIGGER source_capability_event_requests_no_update
BEFORE UPDATE ON source_capability_event_requests
BEGIN
  SELECT RAISE(ABORT, 'source capability event requests are immutable');
END;

CREATE TRIGGER source_capability_event_requests_no_delete
BEFORE DELETE ON source_capability_event_requests
BEGIN
  SELECT RAISE(ABORT, 'source capability event requests are immutable');
END;
