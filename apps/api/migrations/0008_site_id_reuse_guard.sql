-- NOVA Core site identifier reuse protection — 0008
-- Site audit events are append-only and keyed by entity ID. Once a site ID
-- has audit history, do not permit that identifier to be recreated under a
-- different tenant after the original site row is deleted.
CREATE TRIGGER sites_audit_id_reuse_guard
BEFORE INSERT ON sites
WHEN EXISTS (
  SELECT 1
  FROM audit_events e
  WHERE e.entity_type = 'site'
    AND e.entity_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'site ID cannot be reused while audit history exists');
END;
