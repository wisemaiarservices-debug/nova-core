-- NOVA Core tenant membership deletion audit guard — 0016
-- Revoked membership rows may be removed only after terminal revocation has a
-- matching append-only audit event and all old grants have been cleared.
-- Existing non-revoked membership tombstone workflows remain compatible.

CREATE TRIGGER tenant_memberships_delete_audit_guard
BEFORE DELETE ON tenant_memberships
WHEN OLD.status = 'revoked'
  AND (
    NOT EXISTS (
      SELECT 1 FROM audit_events e
      WHERE e.entity_type = 'membership'
        AND e.entity_id = OLD.id
        AND e.tenant_id = OLD.tenant_id
        AND e.action = 'membership.revoked'
    )
    OR EXISTS (
      SELECT 1 FROM tenant_resource_grants g
      WHERE g.tenant_id = OLD.tenant_id
        AND g.subject = OLD.subject
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'revoked membership deletion requires audited revocation and cleared grants');
END;
