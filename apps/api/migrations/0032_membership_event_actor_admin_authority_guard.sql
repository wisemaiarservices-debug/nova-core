-- Require current owner/admin authority for membership lifecycle mutations.
-- Membership creation events are exempt because an invitee records their own
-- creation; all subsequent lifecycle events must be authored by an active
-- tenant owner or administrator in an active tenant.
CREATE TRIGGER tenant_membership_event_actor_admin_authority_guard
BEFORE INSERT ON tenant_membership_events
WHEN NEW.event_type <> 'created'
  AND NOT EXISTS (
    SELECT 1
    FROM tenant_memberships m
    JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
    WHERE m.tenant_id = NEW.tenant_id
      AND m.subject = NEW.actor_subject
      AND m.status = 'active'
      AND m.role IN ('tenant_owner', 'tenant_admin')
  )
BEGIN
  SELECT RAISE(ABORT, 'membership event actor must have active owner or admin authority');
END;
