-- NOVA Core tenant membership lifecycle — 0015
-- Revocation is terminal. Re-adding access requires a new membership identity
-- and explicitly provisioned grants; old grants must never silently revive.
-- Remove grants atomically on revocation so the same principal can later receive
-- a new membership identity despite the (tenant_id, subject) uniqueness rule.

CREATE TRIGGER tenant_memberships_revoked_terminal_guard
BEFORE UPDATE OF status ON tenant_memberships
WHEN OLD.status = 'revoked' AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'revoked membership status is terminal');
END;

CREATE TRIGGER tenant_memberships_revoke_grants_guard
AFTER UPDATE OF status ON tenant_memberships
WHEN OLD.status <> 'revoked' AND NEW.status = 'revoked'
BEGIN
  DELETE FROM tenant_resource_grants
  WHERE tenant_id = NEW.tenant_id AND subject = NEW.subject;
END;
