-- Enforce owner authority for invitation creation and revocation at the event ledger boundary.
-- Acceptance is performed by the invited Access subject; expiry may be recorded by
-- the authenticated holder of the invitation. Those event types remain distinct.

CREATE TRIGGER tenant_membership_invitation_owner_event_guard
BEFORE INSERT ON tenant_membership_invitation_events
WHEN NEW.event_type IN ('created', 'revoked')
  AND NOT EXISTS (
    SELECT 1
    FROM tenant_memberships m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = NEW.tenant_id
      AND m.subject = NEW.actor_subject
      AND m.role = 'tenant_owner'
      AND m.status = 'active'
      AND t.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'membership invitation event actor must be active tenant owner');
END;
