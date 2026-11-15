-- Require an active actor for tenant membership lifecycle audit events.
-- The membership being changed may be suspended/revoked; the actor must remain
-- an active member of the same active tenant.
CREATE TRIGGER tenant_membership_event_actor_active_membership_guard
BEFORE INSERT ON tenant_membership_events
WHEN NOT EXISTS (
  SELECT 1
  FROM tenant_memberships actor
  JOIN tenants t ON t.id = actor.tenant_id AND t.status = 'active'
  WHERE actor.tenant_id = NEW.tenant_id
    AND actor.subject = NEW.actor_subject
    AND actor.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'membership event actor membership must be active');
END;
