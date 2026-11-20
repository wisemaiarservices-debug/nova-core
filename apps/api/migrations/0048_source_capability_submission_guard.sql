-- Capability lifecycle guard: submission_guard.

CREATE TRIGGER source_capability_submission_guard
BEFORE INSERT ON source_capability_events
WHEN NEW.event_type='submitted' AND NOT EXISTS (
  SELECT 1
  FROM source_capabilities c
  JOIN tenant_memberships m ON m.tenant_id=c.tenant_id
    AND m.subject=c.created_by_subject AND m.status='active'
  WHERE c.id=NEW.capability_id AND c.status='pending'
    AND c.created_by_subject=NEW.actor_subject
)
BEGIN
  SELECT RAISE(ABORT, 'capability submission requires its active creator');
END;
