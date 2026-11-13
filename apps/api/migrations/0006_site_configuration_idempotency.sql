-- NOVA site configuration write idempotency — 0006
-- Apply after immutable configuration history (0005). This migration creates
-- no customer rows and enables no write route.
PRAGMA foreign_keys = ON;

CREATE TABLE tenant_site_configuration_idempotency (
  tenant_id TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  configuration_id TEXT NOT NULL CHECK (length(trim(configuration_id)) BETWEEN 1 AND 160),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, subject, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);

CREATE INDEX idx_site_configuration_idempotency_created
  ON tenant_site_configuration_idempotency(created_at);

CREATE TRIGGER site_configuration_idempotency_completion_guard
BEFORE UPDATE ON tenant_site_configuration_idempotency
WHEN OLD.status <> 'pending' OR NEW.status <> 'completed'
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.subject <> OLD.subject
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.request_sha256 <> OLD.request_sha256
  OR NEW.configuration_id <> OLD.configuration_id
  OR OLD.response_json IS NOT NULL
  OR NEW.response_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'idempotency record permits one pending-to-completed transition');
END;

CREATE TRIGGER site_configuration_idempotency_immutable_delete_guard
BEFORE DELETE ON tenant_site_configuration_idempotency
BEGIN
  SELECT RAISE(ABORT, 'configuration idempotency records cannot be deleted');
END;
