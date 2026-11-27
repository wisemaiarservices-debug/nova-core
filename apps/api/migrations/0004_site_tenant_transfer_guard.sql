-- NOVA Core tenant site ownership immutability — 0004
-- A site with dependent tenant-owned records cannot be reassigned to another
-- tenant. Reassignment requires a separately designed, audited transfer
-- workflow that updates and validates every dependent record atomically.

CREATE TRIGGER sites_tenant_transfer_guard
BEFORE UPDATE OF tenant_id ON sites
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  AND (
    EXISTS (SELECT 1 FROM assets a WHERE a.site_id = OLD.id)
    OR EXISTS (SELECT 1 FROM sources s WHERE s.site_id = OLD.id)
    OR EXISTS (SELECT 1 FROM observations o WHERE o.site_id = OLD.id)
  )
BEGIN
  SELECT RAISE(ABORT, 'site tenant cannot change while dependent records exist');
END;
