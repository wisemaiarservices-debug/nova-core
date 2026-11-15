-- Criteria reviewer assignments can remain active after tenant membership is
-- suspended. Enforce active tenant membership at the immutable approval write
-- boundary, alongside the existing jurisdiction, assignment and independence guards.
CREATE TRIGGER water_quality_criteria_approval_active_membership_guard
BEFORE INSERT ON water_quality_criteria_approvals
WHEN NOT EXISTS (
  SELECT 1
  FROM tenant_memberships m
  JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
  WHERE m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.reviewer_subject
    AND m.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'criteria approval reviewer membership must be active');
END;
