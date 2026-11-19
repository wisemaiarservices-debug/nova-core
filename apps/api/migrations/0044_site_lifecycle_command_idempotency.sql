-- Bind each durable lifecycle command to one caller-supplied retry key.
-- The key is scoped to tenant/site/original actor; intent digest is checked by the API.
ALTER TABLE tenant_site_lifecycle_commands ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX idx_tenant_site_lifecycle_command_idempotency
 ON tenant_site_lifecycle_commands(tenant_id,site_id,actor_subject,idempotency_key)
 WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER tenant_site_lifecycle_command_idempotency_insert_guard
BEFORE INSERT ON tenant_site_lifecycle_commands
WHEN NEW.idempotency_key IS NULL OR length(trim(NEW.idempotency_key)) NOT BETWEEN 1 AND 160
BEGIN
 SELECT RAISE(ABORT,'site lifecycle command requires a bounded idempotency key');
END;

CREATE TRIGGER tenant_site_lifecycle_command_idempotency_immutable
BEFORE UPDATE ON tenant_site_lifecycle_commands
WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
BEGIN
 SELECT RAISE(ABORT,'site lifecycle command idempotency key is immutable');
END;
