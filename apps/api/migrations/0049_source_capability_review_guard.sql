-- Capability lifecycle guard: review_guard.

CREATE TRIGGER source_capability_review_guard
BEFORE INSERT ON source_capability_events
WHEN NEW.event_type IN ('approved','rejected','revoked') AND NOT EXISTS (
  SELECT 1
  FROM source_capabilities c
  JOIN tenant_source_reviewers r ON r.tenant_id=c.tenant_id
    AND r.site_id=c.site_id AND r.reviewer_subject=NEW.actor_subject
    AND r.status='active'
  JOIN tenant_memberships m ON m.tenant_id=r.tenant_id
    AND m.subject=r.reviewer_subject AND m.status='active'
  WHERE c.id=NEW.capability_id
    AND c.created_by_subject<>NEW.actor_subject
    AND (
      (NEW.event_type IN ('approved','rejected') AND c.status='pending'
        AND EXISTS (SELECT 1 FROM source_capability_events submitted
          WHERE submitted.capability_id=c.id AND submitted.event_type='submitted'))
      OR (NEW.event_type='revoked' AND c.status='approved')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'capability review requires an independent active reviewer and valid lifecycle');
END;
