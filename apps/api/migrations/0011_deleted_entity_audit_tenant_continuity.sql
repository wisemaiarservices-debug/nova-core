-- NOVA Core deleted-entity audit tenant continuity — 0011
-- Existing-row owner guards cannot compare a tombstone to a deleted row.
-- Preserve the tenant recorded by all prior history for the same entity ID.
-- IS NOT is intentionally NULL-safe: legacy NULL attribution cannot silently
-- be converted into a different tenant attribution by a later tombstone.

CREATE TRIGGER audit_events_deleted_entity_tenant_match_insert_guard
BEFORE INSERT ON audit_events
WHEN
  (
    NEW.entity_type = 'tenant'
    AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.entity_id)
  )
  OR (
    NEW.entity_type = 'membership'
    AND NOT EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.id = NEW.entity_id)
  )
  OR (
    NEW.entity_type = 'site'
    AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = NEW.entity_id)
  )
  OR (
    NEW.entity_type = 'asset'
    AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.entity_id)
  )
  OR (
    NEW.entity_type = 'source'
    AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = NEW.entity_id)
  )
  OR (
    NEW.entity_type = 'observation'
    AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = NEW.entity_id)
  )
  OR NEW.entity_type IN ('experiment', 'dataset_snapshot')
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM audit_events prior
      WHERE prior.entity_type = NEW.entity_type
        AND prior.entity_id = NEW.entity_id
        AND prior.tenant_id IS NOT NEW.tenant_id
    )
    THEN RAISE(ABORT, 'tombstone audit tenant must match history')
  END;
END;
