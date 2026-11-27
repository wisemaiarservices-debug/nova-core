-- NOVA Core related-entity audit ownership immutability — 0012
-- An entity with append-only audit history cannot move to another tenant.
-- A transfer requires an explicit audited workflow that reconciles its history.

CREATE TRIGGER assets_audit_tenant_transfer_guard
BEFORE UPDATE OF tenant_id ON assets
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  AND EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.entity_type = 'asset' AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'asset tenant cannot change while audit history exists');
END;

CREATE TRIGGER sources_audit_tenant_transfer_guard
BEFORE UPDATE OF tenant_id ON sources
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  AND EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.entity_type = 'source' AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'source tenant cannot change while audit history exists');
END;

CREATE TRIGGER observations_audit_tenant_transfer_guard
BEFORE UPDATE OF tenant_id ON observations
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  AND EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.entity_type = 'observation' AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'observation tenant cannot change while audit history exists');
END;
