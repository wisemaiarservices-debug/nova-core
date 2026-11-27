-- NOVA Core audited resource identity immutability — 0013
-- Audit events identify resources by (entity_type, entity_id). Renaming a
-- resource with history would orphan that history from its live identity.
-- Tenant and membership ID guards are already defined in migration 0010.

CREATE TRIGGER sites_audit_id_update_guard
BEFORE UPDATE OF id ON sites
WHEN OLD.id IS NOT NEW.id
  AND EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.entity_type = 'site' AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'site ID cannot change while audit history exists');
END;

CREATE TRIGGER assets_audit_id_update_guard
BEFORE UPDATE OF id ON assets
WHEN OLD.id IS NOT NEW.id
  AND EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.entity_type = 'asset' AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'asset ID cannot change while audit history exists');
END;

CREATE TRIGGER sources_audit_id_update_guard
BEFORE UPDATE OF id ON sources
WHEN OLD.id IS NOT NEW.id
  AND EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.entity_type = 'source' AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'source ID cannot change while audit history exists');
END;

CREATE TRIGGER observations_audit_id_update_guard
BEFORE UPDATE OF id ON observations
WHEN OLD.id IS NOT NEW.id
  AND EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.entity_type = 'observation' AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'observation ID cannot change while audit history exists');
END;
