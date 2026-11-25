-- Protect append-only evidence and rights lifecycle ordering from caller-supplied rowids.
-- The lifecycle guards select the latest event by rowid. SQLite permits INSERT to
-- provide rowid explicitly, so append-only triggers alone do not guarantee order.
-- Require each new event rowid to be exactly one greater than the previous maximum.
-- Normal inserts retain SQLite's automatic rowid behavior; backward and forward
-- rowid injection aborts the statement and preserves the prior lifecycle state.

CREATE TRIGGER source_evidence_events_monotonic_rowid_guard
AFTER INSERT ON source_evidence_events
WHEN NEW.rowid <> COALESCE(
  (SELECT MAX(rowid) FROM source_evidence_events WHERE rowid <> NEW.rowid), 0
) + 1
BEGIN
  SELECT RAISE(ABORT, 'source evidence event rowid must be monotonic');
END;

CREATE TRIGGER source_data_rights_events_monotonic_rowid_guard
AFTER INSERT ON source_data_rights_events
WHEN NEW.rowid <> COALESCE(
  (SELECT MAX(rowid) FROM source_data_rights_events WHERE rowid <> NEW.rowid), 0
) + 1
BEGIN
  SELECT RAISE(ABORT, 'source data rights event rowid must be monotonic');
END;

-- The earlier tenant source registry orders lifecycle events by occurred_at,
-- then rowid. Prevent callers from backdating or future-dating an event so
-- chronological order remains consistent with the append-only event sequence.
CREATE TRIGGER tenant_source_events_monotonic_timestamp_guard
BEFORE INSERT ON tenant_source_events
WHEN julianday(NEW.occurred_at) IS NULL
  OR julianday(NEW.occurred_at) > julianday('now')
  OR julianday(NEW.occurred_at) < COALESCE(
    (SELECT MAX(julianday(occurred_at)) FROM tenant_source_events), julianday(NEW.occurred_at)
  )
BEGIN
  SELECT RAISE(ABORT, 'tenant source event timestamp must be valid and monotonic');
END;

CREATE TRIGGER tenant_source_events_monotonic_rowid_guard
AFTER INSERT ON tenant_source_events
WHEN NEW.rowid <> COALESCE(
  (SELECT MAX(rowid) FROM tenant_source_events WHERE rowid <> NEW.rowid), 0
) + 1
BEGIN
  SELECT RAISE(ABORT, 'tenant source event rowid must be monotonic');
END;
