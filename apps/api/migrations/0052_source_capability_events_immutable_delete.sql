-- Capability lifecycle guard: events_immutable_delete.

CREATE TRIGGER source_capability_events_immutable_delete
BEFORE DELETE ON source_capability_events
BEGIN
  SELECT RAISE(ABORT, 'source capability events cannot be deleted');
END;
