-- Once the durable command API is wired, no lifecycle event may bypass
-- the prepare/apply command ledger by inserting a legacy event directly.
CREATE TRIGGER tenant_site_lifecycle_event_requires_command
BEFORE INSERT ON tenant_site_lifecycle_events
WHEN NEW.command_id IS NULL
BEGIN
 SELECT RAISE(ABORT,'site lifecycle event requires a durable command');
END;
