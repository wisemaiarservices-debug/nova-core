-- NOVA Core tenant ownership immutability — 0004
-- Apply after 0003_internal_request_nonces.sql.
-- Ownership/scope changes use revoke-and-recreate or explicit migration workflows;
-- ordinary updates must not silently move existing records between tenants.

CREATE TRIGGER sites_tenant_immutable_guard
BEFORE UPDATE OF tenant_id ON sites
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'site tenant ownership is immutable');
END;

CREATE TRIGGER sources_tenant_immutable_guard
BEFORE UPDATE OF tenant_id ON sources
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'source tenant ownership is immutable');
END;

CREATE TRIGGER sources_site_immutable_after_observations_guard
BEFORE UPDATE OF site_id ON sources
WHEN NEW.site_id IS NOT OLD.site_id
  AND EXISTS (SELECT 1 FROM observations o WHERE o.source_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'source site cannot change after observations exist');
END;

CREATE TRIGGER observations_source_site_insert_guard
BEFORE INSERT ON observations
WHEN EXISTS (
  SELECT 1 FROM sources src
  WHERE src.id = NEW.source_id
    AND src.site_id IS NOT NULL
    AND src.site_id <> NEW.site_id
)
BEGIN
  SELECT RAISE(ABORT, 'observation site must match its site-bound source');
END;

CREATE TRIGGER observations_source_site_update_guard
BEFORE UPDATE OF site_id, source_id ON observations
WHEN EXISTS (
  SELECT 1 FROM sources src
  WHERE src.id = NEW.source_id
    AND src.site_id IS NOT NULL
    AND src.site_id <> NEW.site_id
)
BEGIN
  SELECT RAISE(ABORT, 'observation site must match its site-bound source');
END;

CREATE TRIGGER audit_events_tenant_immutable_guard
BEFORE UPDATE OF tenant_id ON audit_events
WHEN OLD.tenant_id IS NOT NULL AND NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'audit event tenant ownership is immutable');
END;

CREATE TRIGGER tenant_memberships_scope_immutable_guard
BEFORE UPDATE OF tenant_id, subject ON tenant_memberships
WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.subject IS NOT OLD.subject
BEGIN
  SELECT RAISE(ABORT, 'membership identity scope is immutable; revoke and recreate');
END;

CREATE TRIGGER tenant_resource_grants_scope_immutable_guard
BEFORE UPDATE OF tenant_id, subject, resource_type, resource_id, action
ON tenant_resource_grants
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.subject IS NOT OLD.subject
  OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.action IS NOT OLD.action
BEGIN
  SELECT RAISE(ABORT, 'grant scope is immutable; revoke and recreate');
END;

CREATE TRIGGER assets_tenant_immutable_guard
BEFORE UPDATE OF tenant_id ON assets
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'asset tenant ownership is immutable');
END;

CREATE TRIGGER observations_tenant_immutable_guard
BEFORE UPDATE OF tenant_id ON observations
WHEN NEW.tenant_id IS NOT OLD.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'observation tenant ownership is immutable');
END;
