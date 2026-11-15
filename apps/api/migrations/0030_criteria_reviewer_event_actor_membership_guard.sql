-- Reviewer assignment history records the tenant actor who assigned or
-- revoked a reviewer. Enforce that actor's active membership at the immutable
-- event write boundary, not only in the HTTP authorization path.
CREATE TRIGGER water_quality_criteria_reviewer_event_actor_active_membership_guard
BEFORE INSERT ON water_quality_criteria_reviewer_events
WHEN NOT EXISTS (
  SELECT 1
  FROM tenant_memberships m
  JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
  WHERE m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.actor_subject
    AND m.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'criteria reviewer event actor membership must be active');
END;
