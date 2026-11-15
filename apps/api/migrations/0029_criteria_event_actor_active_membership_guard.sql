-- Criteria lifecycle events are tenant-authored records. Enforce active
-- membership for the actor at the immutable event write boundary, including
-- events emitted by authors and tenant administrators (not only reviewers).
CREATE TRIGGER water_quality_criteria_event_actor_active_membership_guard
BEFORE INSERT ON water_quality_criteria_events
WHEN NOT EXISTS (
  SELECT 1
  FROM tenant_memberships m
  JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
  WHERE m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.actor_subject
    AND m.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'criteria event actor membership must be active');
END;
