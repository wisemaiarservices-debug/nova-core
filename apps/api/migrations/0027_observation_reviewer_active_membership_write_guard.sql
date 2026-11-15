-- Observation verification assignments may remain active after tenant membership
-- is suspended. Recheck the authenticated reviewer membership at the immutable
-- verification-event write boundary, in addition to the existing site assignment
-- and tenant-state guards.
CREATE TRIGGER observation_verification_reviewer_membership_guard
BEFORE INSERT ON observation_verification_events
WHEN NOT EXISTS (
  SELECT 1
  FROM tenant_memberships m
  JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
  WHERE m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.reviewer_subject
    AND m.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'observation verification reviewer membership must be active');
END;
