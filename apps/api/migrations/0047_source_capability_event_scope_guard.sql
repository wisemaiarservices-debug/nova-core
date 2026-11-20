-- Capability lifecycle guard: event_scope_guard.

CREATE TRIGGER source_capability_event_scope_guard
BEFORE INSERT ON source_capability_events
WHEN NOT EXISTS (
  SELECT 1
  FROM source_capabilities c
  JOIN sources src ON src.id=c.source_id AND src.tenant_id=c.tenant_id
    AND src.site_id=c.site_id AND src.module=c.module
  JOIN tenants t ON t.id=c.tenant_id AND t.status='active'
  JOIN sites s ON s.id=c.site_id AND s.tenant_id=c.tenant_id AND s.status='active'
  WHERE c.id=NEW.capability_id AND c.tenant_id=NEW.tenant_id
    AND c.site_id=NEW.site_id AND c.source_id=NEW.source_id
    AND (NEW.event_type='revoked' OR src.verification_status='verified')
)
BEGIN
  SELECT RAISE(ABORT, 'source capability event scope or source verification is invalid');
END;
