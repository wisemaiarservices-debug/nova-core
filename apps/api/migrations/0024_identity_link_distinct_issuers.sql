-- Enforce distinct identity-provider issuers for every new identity-link challenge.
-- The Supabase Auth and Cloudflare Access identities must be independently
-- verifiable under separate issuer authorities, even for direct SQL writes.

CREATE TRIGGER identity_link_challenge_distinct_issuers
BEFORE INSERT ON tenant_identity_link_challenges
WHEN NEW.supabase_issuer = NEW.cloudflare_issuer
BEGIN
  SELECT RAISE(ABORT, 'identity-link providers must use distinct issuers');
END;
