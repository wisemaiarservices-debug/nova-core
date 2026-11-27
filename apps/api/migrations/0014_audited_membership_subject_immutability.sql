-- NOVA Core audited membership principal identity immutability — 0014
-- A membership subject is the authenticated principal bound to the membership.
-- Reassigning it after audit history exists would change the principal associated
-- with the historical membership identity.

CREATE TRIGGER tenant_memberships_audit_subject_update_guard
BEFORE UPDATE OF subject ON tenant_memberships
WHEN OLD.subject IS NOT NEW.subject
  AND EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.entity_type = 'membership' AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'membership subject cannot change while audit history exists');
END;
