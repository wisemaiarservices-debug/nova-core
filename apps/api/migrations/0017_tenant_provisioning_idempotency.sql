-- NOVA Core controlled tenant provisioning idempotency — 0017
-- This table stores only server-generated tenant creation outcomes. It does not
-- grant access and must be written only by the private Tenant API.

CREATE TABLE tenant_provisioning_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  tenant_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(actor_subject, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
CREATE INDEX idx_tenant_provisioning_requests_tenant
  ON tenant_provisioning_requests(tenant_id, created_at DESC);

CREATE TRIGGER tenant_provisioning_requests_no_update
BEFORE UPDATE ON tenant_provisioning_requests
BEGIN
  SELECT RAISE(ABORT, 'tenant provisioning requests are immutable');
END;

CREATE TRIGGER tenant_provisioning_requests_no_delete
BEFORE DELETE ON tenant_provisioning_requests
BEGIN
  SELECT RAISE(ABORT, 'tenant provisioning requests are immutable');
END;
