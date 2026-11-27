-- NOVA Core tenant membership lifecycle — 0015
-- Revocation is terminal. Re-adding access requires a new membership identity
-- and explicitly provisioned grants; old grants must never silently revive.

CREATE TRIGGER tenant_memberships_revoked_terminal_guard
BEFORE UPDATE OF status ON tenant_memberships
WHEN OLD.status = 'revoked' AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'revoked membership status is terminal');
END;
