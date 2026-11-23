-- Capability lifecycle guard: events_immutable_update.

CREATE TRIGGER source_capability_events_immutable_update
BEFORE UPDATE ON source_capability_events
BEGIN
  SELECT RAISE(ABORT, 'source capability events are immutable');
END;
