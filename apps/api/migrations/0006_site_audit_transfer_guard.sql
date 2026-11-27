-- NOVA Core site audit ownership immutability — 0006
-- Site audit events are append-only and tenant-scoped. A site cannot move to
-- another tenant while its historical audit events remain owned by the
-- original tenant. A future transfer workflow must explicitly define audited
-- history disposition before any ownership change is permitted.

CREATE TRIGGER sites_tenant_audit_transfer_guard
BEFORE UPDATE OF tenant_id ON sites
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  AND EXISTS (
    SELECT 1
    FROM audit_events e
    WHERE e.entity_type = 'site'
      AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'site tenant cannot change while audit history exists');
END;
