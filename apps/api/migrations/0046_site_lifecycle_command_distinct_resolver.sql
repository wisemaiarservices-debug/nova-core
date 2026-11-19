-- A resolver must be a different principal from the original command actor.
-- This is required even when the site status has changed: stale intent is resolved
-- by a separately attributable administrator, not self-rejected by its author.
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
       NEW.resolved_by_subject=OLD.actor_subject OR
       length(trim(NEW.resolved_by_subject)) NOT BETWEEN 1 AND 200 OR
       NEW.rejection_code IS NULL OR NEW.rejection_code NOT IN ('original_actor_revoked','site_status_changed') OR
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
       (NEW.rejection_code='original_actor_revoked' AND EXISTS (
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
       )) OR
       (NEW.rejection_code='site_status_changed' AND NOT EXISTS (
         SELECT 1 FROM sites site
         WHERE site.id=OLD.site_id AND site.tenant_id=OLD.tenant_id
           AND site.status<>OLD.expected_status
       ))
     ))
BEGIN
 SELECT RAISE(ABORT,'site lifecycle command terminal transition is unauthorized or not eligible for resolution');
END;

-- Keep the dedicated immutable-key guard newest so its precise failure remains
-- observable before the broader command state-machine guard.
DROP TRIGGER tenant_site_lifecycle_command_idempotency_immutable;
CREATE TRIGGER tenant_site_lifecycle_command_idempotency_immutable
BEFORE UPDATE ON tenant_site_lifecycle_commands
WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
BEGIN
 SELECT RAISE(ABORT,'site lifecycle command idempotency key is immutable');
END;
