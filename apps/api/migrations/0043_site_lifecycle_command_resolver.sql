-- Separately attribute administrative rejection of abandoned lifecycle commands.
-- The original command actor remains immutable; the resolver is recorded independently.

ALTER TABLE tenant_site_lifecycle_commands ADD COLUMN resolved_by_subject TEXT;
ALTER TABLE tenant_site_lifecycle_command_events ADD COLUMN performed_by_subject TEXT;

DROP TRIGGER tenant_site_lifecycle_command_record_prepared;
CREATE TRIGGER tenant_site_lifecycle_command_record_prepared
AFTER INSERT ON tenant_site_lifecycle_commands
BEGIN
 INSERT INTO tenant_site_lifecycle_command_events
  (id,command_id,tenant_id,site_id,actor_subject,event_type,occurred_at,performed_by_subject)
 VALUES('prepared:'||NEW.id,NEW.id,NEW.tenant_id,NEW.site_id,NEW.actor_subject,
        'prepared',NEW.created_at,NEW.actor_subject);
END;

DROP TRIGGER tenant_site_lifecycle_command_update_guard;
CREATE TRIGGER tenant_site_lifecycle_command_update_guard
BEFORE UPDATE ON tenant_site_lifecycle_commands
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR
     NEW.site_id IS NOT OLD.site_id OR NEW.actor_subject IS NOT OLD.actor_subject OR
     NEW.action IS NOT OLD.action OR NEW.expected_status IS NOT OLD.expected_status OR
     NEW.reason IS NOT OLD.reason OR NEW.request_digest IS NOT OLD.request_digest OR
     NEW.created_at IS NOT OLD.created_at OR OLD.status<>'pending' OR
     NEW.status NOT IN ('applied','rejected') OR
     OLD.resolved_by_subject IS NOT NULL OR
     (NEW.status='applied' AND (
       NEW.resolved_by_subject IS NOT NULL OR NEW.rejection_code IS NOT NULL OR
       NOT EXISTS (
         SELECT 1 FROM tenant_site_lifecycle_events event
         WHERE event.id=NEW.event_id AND event.command_id=OLD.id
           AND event.tenant_id=OLD.tenant_id AND event.site_id=OLD.site_id
           AND event.actor_subject=OLD.actor_subject
           AND event.request_digest=OLD.request_digest
       )
     )) OR
     (NEW.status='rejected' AND (
       NEW.event_id IS NOT NULL OR NEW.resolved_by_subject IS NULL OR
       length(trim(NEW.resolved_by_subject)) NOT BETWEEN 1 AND 200 OR
       NEW.rejection_code IS NULL OR length(trim(NEW.rejection_code)) NOT BETWEEN 1 AND 120 OR
       NOT EXISTS (
         SELECT 1
         FROM tenants tenant
         JOIN tenant_memberships resolver
           ON resolver.tenant_id=tenant.id
          AND resolver.subject=NEW.resolved_by_subject
          AND resolver.status='active'
          AND resolver.role IN ('tenant_owner','tenant_admin')
         JOIN tenant_resource_grants grant_read
           ON grant_read.tenant_id=tenant.id
          AND grant_read.subject=resolver.subject
          AND grant_read.resource_type='site'
          AND grant_read.resource_id=OLD.site_id
          AND grant_read.action='read'
         WHERE tenant.id=OLD.tenant_id AND tenant.status='active'
       ) OR
       NOT (
         NOT EXISTS (
           SELECT 1
           FROM tenant_memberships original
           JOIN tenant_resource_grants original_grant
             ON original_grant.tenant_id=original.tenant_id
            AND original_grant.subject=original.subject
            AND original_grant.resource_type='site'
            AND original_grant.resource_id=OLD.site_id
            AND original_grant.action='read'
           WHERE original.tenant_id=OLD.tenant_id
             AND original.subject=OLD.actor_subject
             AND original.status='active'
             AND original.role IN ('tenant_owner','tenant_admin')
         )
         OR EXISTS (
           SELECT 1 FROM sites site
           WHERE site.id=OLD.site_id AND site.tenant_id=OLD.tenant_id
             AND site.status<>OLD.expected_status
         )
       )
     ))
BEGIN
 SELECT RAISE(ABORT,'site lifecycle command terminal transition is unauthorized or not eligible for resolution');
END;

DROP TRIGGER tenant_site_lifecycle_command_record_terminal;
CREATE TRIGGER tenant_site_lifecycle_command_record_terminal
AFTER UPDATE OF status ON tenant_site_lifecycle_commands
WHEN NEW.status<>OLD.status
BEGIN
 INSERT INTO tenant_site_lifecycle_command_events
  (id,command_id,tenant_id,site_id,actor_subject,event_type,occurred_at,
   rejection_code,performed_by_subject)
 VALUES(
  NEW.status||':'||NEW.id,NEW.id,NEW.tenant_id,NEW.site_id,NEW.actor_subject,
  NEW.status,NEW.updated_at,NEW.rejection_code,
  CASE WHEN NEW.status='rejected' THEN NEW.resolved_by_subject ELSE NEW.actor_subject END
 );
END;
