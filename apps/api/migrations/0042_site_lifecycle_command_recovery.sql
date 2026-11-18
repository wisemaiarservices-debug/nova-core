-- Durable command intent for site lifecycle transitions.
-- Existing lifecycle events remain the authoritative, append-only applied facts.
-- This migration is additive; runtime cutover is a separate change.

ALTER TABLE tenant_site_lifecycle_events ADD COLUMN command_id TEXT;

CREATE UNIQUE INDEX idx_tenant_site_lifecycle_event_command
 ON tenant_site_lifecycle_events(command_id)
 WHERE command_id IS NOT NULL;

CREATE TABLE tenant_site_lifecycle_commands (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK(length(trim(actor_subject)) BETWEEN 1 AND 200),
  action TEXT NOT NULL CHECK(action IN ('deactivate','reactivate')),
  expected_status TEXT NOT NULL CHECK(expected_status IN ('active','inactive')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected')),
  event_id TEXT UNIQUE,
  rejection_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id,tenant_id,site_id,actor_subject,action,expected_status,request_digest),
  FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE RESTRICT,
  CHECK((action='deactivate' AND expected_status='active') OR
        (action='reactivate' AND expected_status='inactive')),
  CHECK((status='pending' AND event_id IS NULL AND rejection_code IS NULL) OR
        (status='applied' AND event_id IS NOT NULL AND rejection_code IS NULL) OR
        (status='rejected' AND event_id IS NULL AND length(trim(rejection_code)) BETWEEN 1 AND 120))
);

-- A site can have only one unresolved transition, regardless of actor.
CREATE UNIQUE INDEX idx_tenant_site_lifecycle_one_pending_command
 ON tenant_site_lifecycle_commands(tenant_id,site_id)
 WHERE status='pending';

CREATE INDEX idx_tenant_site_lifecycle_commands_actor
 ON tenant_site_lifecycle_commands(tenant_id,site_id,actor_subject,created_at DESC,id);

CREATE TABLE tenant_site_lifecycle_command_events (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) BETWEEN 1 AND 160),
  command_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('prepared','applied','rejected')),
  occurred_at TEXT NOT NULL,
  rejection_code TEXT,
  FOREIGN KEY(command_id) REFERENCES tenant_site_lifecycle_commands(id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE RESTRICT,
  CHECK((event_type='rejected' AND rejection_code IS NOT NULL AND length(trim(rejection_code)) BETWEEN 1 AND 120) OR
        (event_type IN ('prepared','applied') AND rejection_code IS NULL))
);

CREATE INDEX idx_tenant_site_lifecycle_command_timeline
 ON tenant_site_lifecycle_command_events(command_id,occurred_at,id);

CREATE TRIGGER tenant_site_lifecycle_command_insert_guard
BEFORE INSERT ON tenant_site_lifecycle_commands
WHEN NEW.status<>'pending' OR NOT EXISTS (
  SELECT 1
  FROM sites site
  JOIN tenants tenant ON tenant.id=site.tenant_id AND tenant.status='active'
  JOIN tenant_memberships membership ON membership.tenant_id=site.tenant_id
    AND membership.subject=NEW.actor_subject AND membership.status='active'
    AND membership.role IN ('tenant_owner','tenant_admin')
  JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=site.tenant_id
    AND grant_read.subject=NEW.actor_subject AND grant_read.resource_type='site'
    AND grant_read.resource_id=site.id AND grant_read.action='read'
  WHERE site.id=NEW.site_id AND site.tenant_id=NEW.tenant_id
    AND site.status=NEW.expected_status
)
BEGIN
 SELECT RAISE(ABORT,'site lifecycle command requires active tenant, authorized admin, exact site grant and expected status');
END;

CREATE TRIGGER tenant_site_lifecycle_command_record_prepared
AFTER INSERT ON tenant_site_lifecycle_commands
BEGIN
 INSERT INTO tenant_site_lifecycle_command_events
  (id,command_id,tenant_id,site_id,actor_subject,event_type,occurred_at)
 VALUES('prepared:'||NEW.id,NEW.id,NEW.tenant_id,NEW.site_id,NEW.actor_subject,'prepared',NEW.created_at);
END;

CREATE TRIGGER tenant_site_lifecycle_command_update_guard
BEFORE UPDATE ON tenant_site_lifecycle_commands
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR
     NEW.site_id IS NOT OLD.site_id OR NEW.actor_subject IS NOT OLD.actor_subject OR
     NEW.action IS NOT OLD.action OR NEW.expected_status IS NOT OLD.expected_status OR
     NEW.reason IS NOT OLD.reason OR NEW.request_digest IS NOT OLD.request_digest OR
     NEW.created_at IS NOT OLD.created_at OR OLD.status<>'pending' OR
     NEW.status NOT IN ('applied','rejected') OR
     (NEW.status='applied' AND NOT EXISTS (
       SELECT 1 FROM tenant_site_lifecycle_events event
       WHERE event.id=NEW.event_id AND event.command_id=OLD.id
         AND event.tenant_id=OLD.tenant_id AND event.site_id=OLD.site_id
         AND event.actor_subject=OLD.actor_subject
         AND event.request_digest=OLD.request_digest
     )) OR
     (NEW.status='rejected' AND (NEW.event_id IS NOT NULL OR
       NEW.rejection_code IS NULL OR length(trim(NEW.rejection_code)) NOT BETWEEN 1 AND 120))
BEGIN
 SELECT RAISE(ABORT,'site lifecycle command permits only immutable pending-to-terminal transitions');
END;

CREATE TRIGGER tenant_site_lifecycle_command_record_terminal
AFTER UPDATE OF status ON tenant_site_lifecycle_commands
WHEN NEW.status<>OLD.status
BEGIN
 INSERT INTO tenant_site_lifecycle_command_events
  (id,command_id,tenant_id,site_id,actor_subject,event_type,occurred_at,rejection_code)
 VALUES(
  NEW.status||':'||NEW.id,NEW.id,NEW.tenant_id,NEW.site_id,NEW.actor_subject,
  NEW.status,NEW.updated_at,NEW.rejection_code
 );
END;

CREATE TRIGGER tenant_site_lifecycle_event_command_guard
BEFORE INSERT ON tenant_site_lifecycle_events
WHEN NEW.command_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM tenant_site_lifecycle_commands command
 WHERE command.id=NEW.command_id AND command.tenant_id=NEW.tenant_id
   AND command.site_id=NEW.site_id AND command.actor_subject=NEW.actor_subject
   AND command.status='pending' AND command.request_digest=NEW.request_digest
   AND command.reason=NEW.reason
   AND ((command.action='deactivate' AND NEW.event_type='deactivated'
         AND command.expected_status='active' AND NEW.previous_status='active' AND NEW.new_status='inactive')
     OR (command.action='reactivate' AND NEW.event_type='reactivated'
         AND command.expected_status='inactive' AND NEW.previous_status='inactive' AND NEW.new_status='active'))
)
BEGIN
 SELECT RAISE(ABORT,'site lifecycle event must consume its exact pending command');
END;

CREATE TRIGGER tenant_site_lifecycle_event_terminalizes_command
AFTER INSERT ON tenant_site_lifecycle_events
WHEN NEW.command_id IS NOT NULL
BEGIN
 UPDATE tenant_site_lifecycle_commands
 SET status='applied',event_id=NEW.id,updated_at=NEW.occurred_at
 WHERE id=NEW.command_id AND status='pending';
 SELECT CASE WHEN changes()<>1
  THEN RAISE(ABORT,'site lifecycle command was not terminalized exactly once') END;
END;

CREATE TRIGGER tenant_site_lifecycle_commands_no_delete
BEFORE DELETE ON tenant_site_lifecycle_commands
BEGIN
 SELECT RAISE(ABORT,'site lifecycle commands are retained for audit'); 
END;
CREATE TRIGGER tenant_site_lifecycle_command_events_no_update
BEFORE UPDATE ON tenant_site_lifecycle_command_events
BEGIN
 SELECT RAISE(ABORT,'site lifecycle command events are append-only');
END;
CREATE TRIGGER tenant_site_lifecycle_command_events_no_delete
BEFORE DELETE ON tenant_site_lifecycle_command_events
BEGIN
 SELECT RAISE(ABORT,'site lifecycle command events are append-only');
END;
