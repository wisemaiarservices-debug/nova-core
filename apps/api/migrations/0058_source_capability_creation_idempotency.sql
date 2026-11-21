-- Source capability draft creation idempotency and audit — 0058
-- The request row is committed in the same D1 batch as the immutable capability
-- definition and audit event. It is not an approval or ingestion authorization.

PRAGMA foreign_keys = ON;

CREATE TABLE source_capability_creation_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  capability_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, site_id, actor_subject, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (capability_id) REFERENCES source_capabilities(id) ON DELETE RESTRICT
);

CREATE INDEX idx_source_capability_creation_requests_timeline
  ON source_capability_creation_requests(tenant_id, site_id, created_at DESC);

CREATE TRIGGER source_capability_creation_request_insert_guard
BEFORE INSERT ON source_capability_creation_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM source_capabilities c
  JOIN tenants t ON t.id = NEW.tenant_id AND t.status = 'active'
  JOIN sites s ON s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id AND s.status = 'active'
  JOIN tenant_memberships m ON m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.actor_subject AND m.status = 'active'
    AND m.role IN ('tenant_owner','tenant_admin')
  JOIN tenant_resource_grants g ON g.tenant_id = NEW.tenant_id
    AND g.subject = NEW.actor_subject AND g.resource_type = 'site'
    AND g.resource_id = NEW.site_id AND g.action = 'read'
  JOIN audit_events a ON a.tenant_id = NEW.tenant_id
    AND a.actor_type = 'operator' AND a.actor_id = NEW.actor_subject
    AND a.action = 'source_capability.created'
    AND a.entity_type = 'source_capability' AND a.entity_id = NEW.capability_id
    AND a.request_id = NEW.request_id
  WHERE c.id = NEW.capability_id AND c.tenant_id = NEW.tenant_id
    AND c.site_id = NEW.site_id AND c.created_by_subject = NEW.actor_subject
    AND c.status = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'source capability creation request requires committed draft, active owner/admin, site grant and audit');
END;

CREATE TRIGGER source_capability_creation_requests_no_update
BEFORE UPDATE ON source_capability_creation_requests
BEGIN
  SELECT RAISE(ABORT, 'source capability creation requests are immutable');
END;

CREATE TRIGGER source_capability_creation_requests_no_delete
BEFORE DELETE ON source_capability_creation_requests
BEGIN
  SELECT RAISE(ABORT, 'source capability creation requests are immutable');
END;
