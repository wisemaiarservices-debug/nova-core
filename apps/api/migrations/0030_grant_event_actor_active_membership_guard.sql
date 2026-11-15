-- Enforce an active actor membership at the immutable grant-audit write boundary.
-- Authorization is still checked by the private Tenant API; this guard prevents
-- stale or bypassed actors from appending grant events after membership changes.
CREATE TRIGGER tenant_site_grant_event_actor_active_membership_guard
BEFORE INSERT ON tenant_site_grant_events
WHEN NOT EXISTS (
  SELECT 1
  FROM tenant_memberships m
  JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
  WHERE m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.actor_subject
    AND m.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'site grant event actor membership must be active');
END;

CREATE TRIGGER tenant_resource_grant_event_actor_active_membership_guard
BEFORE INSERT ON tenant_resource_grant_events
WHEN NOT EXISTS (
  SELECT 1
  FROM tenant_memberships m
  JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
  WHERE m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.actor_subject
    AND m.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'resource grant event actor membership must be active');
END;
