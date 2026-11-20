-- Capability lifecycle insert guard.

CREATE TRIGGER source_capability_insert_guard
BEFORE INSERT ON source_capabilities
WHEN NEW.status <> 'pending'
  OR NOT EXISTS (
    SELECT 1 FROM sources src
    JOIN tenants t ON t.id=src.tenant_id AND t.status='active'
    JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
    WHERE src.id=NEW.source_id AND src.tenant_id=NEW.tenant_id
      AND src.site_id=NEW.site_id AND src.module=NEW.module
      AND src.verification_status='verified'
  )
  OR NOT EXISTS (
    SELECT 1 FROM tenant_memberships m
    WHERE m.tenant_id=NEW.tenant_id AND m.subject=NEW.created_by_subject
      AND m.status='active'
  )
  OR (NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM assets a WHERE a.id=NEW.asset_id
      AND a.tenant_id=NEW.tenant_id AND a.site_id=NEW.site_id AND a.status='active'
  ))
  OR EXISTS (
    SELECT 1 FROM source_capabilities prior
    WHERE prior.tenant_id=NEW.tenant_id AND prior.site_id=NEW.site_id
      AND prior.source_id=NEW.source_id
      AND COALESCE(prior.asset_id,'')=COALESCE(NEW.asset_id,'')
      AND prior.module=NEW.module AND prior.metric=NEW.metric
      AND prior.unit=NEW.unit AND prior.version>=NEW.version
  )
BEGIN
  SELECT RAISE(ABORT, 'source capability requires verified source, active scope and a new pending version');
END;
