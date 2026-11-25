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
