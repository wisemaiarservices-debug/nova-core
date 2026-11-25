-- Preserve audit history at the database boundary.
-- A legacy event may receive tenant_id exactly once when an operator completes
-- the tenant backfill described by migration 0002. After that assignment, the
-- event is immutable; all other audit fields are immutable from insertion.
CREATE TRIGGER audit_events_immutable_update_guard
BEFORE UPDATE ON audit_events
WHEN
  NEW.id IS NOT OLD.id
  OR NEW.actor_type IS NOT OLD.actor_type
  OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.action IS NOT OLD.action
  OR NEW.entity_type IS NOT OLD.entity_type
  OR NEW.entity_id IS NOT OLD.entity_id
  OR NEW.occurred_at IS NOT OLD.occurred_at
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.details_json IS NOT OLD.details_json
  OR (OLD.tenant_id IS NOT NULL AND NEW.tenant_id IS NOT OLD.tenant_id)
  OR (OLD.tenant_id IS NULL AND NEW.tenant_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER audit_events_immutable_delete_guard
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events cannot be deleted');
END;

-- SQLite's REPLACE conflict algorithm can delete a conflicting row without
-- firing DELETE triggers when recursive triggers are disabled. Reject an
-- existing primary key before the conflict algorithm can replace that row.
CREATE TRIGGER audit_events_immutable_insert_guard
BEFORE INSERT ON audit_events
WHEN EXISTS (SELECT 1 FROM audit_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;
