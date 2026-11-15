-- Reviewer assignments are site-scoped, but tenant membership can later be
-- suspended independently. Recheck active membership at the immutable event
-- write boundary so stale reviewer assignments cannot authorize new decisions.
CREATE TRIGGER sensor_source_mapping_event_active_membership_guard
BEFORE INSERT ON sensor_source_mapping_events
WHEN NOT EXISTS (
  SELECT 1
  FROM tenant_memberships m
  JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
  WHERE m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.reviewer_subject
    AND m.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'sensor source mapping reviewer membership must be active');
END;

CREATE TRIGGER sensor_calibration_verification_active_membership_guard
BEFORE INSERT ON sensor_calibration_verification_events
WHEN NOT EXISTS (
  SELECT 1
  FROM tenant_memberships m
  JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
  WHERE m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.reviewer_subject
    AND m.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'sensor calibration reviewer membership must be active');
END;
