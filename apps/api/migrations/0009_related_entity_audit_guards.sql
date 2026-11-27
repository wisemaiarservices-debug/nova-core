-- NOVA Core related tenant-entity audit integrity — 0009
-- Site-specific equivalents are in migrations 0007 and 0008. Extend the
-- same owner-attribution and historical-ID protections to assets, sources,
-- and observations. Absent rows remain valid for deletion/tombstone events.

CREATE TRIGGER audit_events_asset_tenant_match_insert_guard
BEFORE INSERT ON audit_events
WHEN NEW.entity_type = 'asset'
  AND EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.entity_id)
  AND NOT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = NEW.entity_id AND a.tenant_id = NEW.tenant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'audit event tenant must match entity');
END;

CREATE TRIGGER audit_events_source_tenant_match_insert_guard
BEFORE INSERT ON audit_events
WHEN NEW.entity_type = 'source'
  AND EXISTS (SELECT 1 FROM sources s WHERE s.id = NEW.entity_id)
  AND NOT EXISTS (
    SELECT 1 FROM sources s
    WHERE s.id = NEW.entity_id AND s.tenant_id = NEW.tenant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'audit event tenant must match entity');
END;

CREATE TRIGGER audit_events_observation_tenant_match_insert_guard
BEFORE INSERT ON audit_events
WHEN NEW.entity_type = 'observation'
  AND EXISTS (SELECT 1 FROM observations o WHERE o.id = NEW.entity_id)
  AND NOT EXISTS (
    SELECT 1 FROM observations o
    WHERE o.id = NEW.entity_id AND o.tenant_id = NEW.tenant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'audit event tenant must match entity');
END;

CREATE TRIGGER assets_audit_id_reuse_guard
BEFORE INSERT ON assets
WHEN EXISTS (
  SELECT 1 FROM audit_events e
  WHERE e.entity_type = 'asset' AND e.entity_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'asset ID cannot be reused while audit history exists');
END;

CREATE TRIGGER sources_audit_id_reuse_guard
BEFORE INSERT ON sources
WHEN EXISTS (
  SELECT 1 FROM audit_events e
  WHERE e.entity_type = 'source' AND e.entity_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'source ID cannot be reused while audit history exists');
END;

CREATE TRIGGER observations_audit_id_reuse_guard
BEFORE INSERT ON observations
WHEN EXISTS (
  SELECT 1 FROM audit_events e
  WHERE e.entity_type = 'observation' AND e.entity_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'observation ID cannot be reused while audit history exists');
END;
