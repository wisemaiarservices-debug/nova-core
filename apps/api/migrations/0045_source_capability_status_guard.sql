-- Capability lifecycle guard: status_guard.

CREATE TRIGGER source_capability_status_guard
BEFORE UPDATE OF status ON source_capabilities
WHEN NOT (
  (OLD.status='pending' AND NEW.status='approved'
    AND EXISTS (SELECT 1 FROM source_capability_events e
      WHERE e.capability_id=OLD.id AND e.event_type='approved'))
  OR (OLD.status='pending' AND NEW.status='rejected'
    AND EXISTS (SELECT 1 FROM source_capability_events e
      WHERE e.capability_id=OLD.id AND e.event_type='rejected'))
  OR (OLD.status='approved' AND NEW.status='revoked'
    AND EXISTS (SELECT 1 FROM source_capability_events e
      WHERE e.capability_id=OLD.id AND e.event_type='revoked'))
)
BEGIN
  SELECT RAISE(ABORT, 'source capability status transition requires its matching review event');
END;
