-- NOVA Core site audit tenant attribution integrity — 0007
-- For an existing site, a new site audit event must be attributed to the
-- tenant that currently owns that site. Events for absent sites remain
-- permitted so deletion/tombstone history can be recorded after removal.
CREATE TRIGGER audit_events_site_tenant_match_insert_guard
BEFORE INSERT ON audit_events
WHEN NEW.entity_type = 'site'
  AND EXISTS (
    SELECT 1 FROM sites s WHERE s.id = NEW.entity_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM sites s
    WHERE s.id = NEW.entity_id
      AND s.tenant_id = NEW.tenant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'site audit event tenant must match site');
END;
