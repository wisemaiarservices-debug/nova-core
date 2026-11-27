-- NOVA Core tenant and membership audit identity integrity — 0010
-- Tenant and membership are explicitly tenant-owned audit entity types in 0002.
-- Keep audit attribution aligned with the current owner and prevent identity reuse.

CREATE TRIGGER audit_events_tenant_entity_match_insert_guard
BEFORE INSERT ON audit_events
WHEN NEW.entity_type = 'tenant'
  AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.entity_id)
  AND NEW.tenant_id <> NEW.entity_id
BEGIN
  SELECT RAISE(ABORT, 'audit event tenant must match entity');
END;

CREATE TRIGGER audit_events_membership_entity_match_insert_guard
BEFORE INSERT ON audit_events
WHEN NEW.entity_type = 'membership'
  AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.id = NEW.entity_id)
  AND NOT EXISTS (
    SELECT 1 FROM tenant_memberships m
    WHERE m.id = NEW.entity_id AND m.tenant_id = NEW.tenant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'audit event tenant must match entity');
END;

CREATE TRIGGER tenant_memberships_audit_tenant_transfer_guard
BEFORE UPDATE OF tenant_id ON tenant_memberships
WHEN OLD.tenant_id <> NEW.tenant_id
  AND EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.entity_type = 'membership' AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'membership tenant cannot change while audit history exists');
END;

CREATE TRIGGER tenants_audit_id_reuse_guard
BEFORE INSERT ON tenants
WHEN EXISTS (
  SELECT 1 FROM audit_events e
  WHERE e.entity_type = 'tenant' AND e.entity_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'tenant ID cannot be reused while audit history exists');
END;

CREATE TRIGGER tenant_memberships_audit_id_reuse_guard
BEFORE INSERT ON tenant_memberships
WHEN EXISTS (
  SELECT 1 FROM audit_events e
  WHERE e.entity_type = 'membership' AND e.entity_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'membership ID cannot be reused while audit history exists');
END;

CREATE TRIGGER tenants_audit_id_update_guard
BEFORE UPDATE OF id ON tenants
WHEN OLD.id <> NEW.id
  AND EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.entity_type = 'tenant' AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'tenant ID cannot change while audit history exists');
END;

CREATE TRIGGER tenant_memberships_audit_id_update_guard
BEFORE UPDATE OF id ON tenant_memberships
WHEN OLD.id <> NEW.id
  AND EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.entity_type = 'membership' AND e.entity_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'membership ID cannot change while audit history exists');
END;
