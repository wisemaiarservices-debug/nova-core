-- Enforce unambiguous active identity mappings within each tenant.
-- A Supabase identity and a Cloudflare Access identity can each map to only
-- one counterpart per tenant. Different tenants may independently approve
-- the same pair. Revoked links release the mapping for a future reviewed link.

CREATE UNIQUE INDEX idx_identity_link_active_supabase_identity
  ON tenant_identity_link_requests(tenant_id, supabase_issuer, supabase_subject)
  WHERE status = 'approved';

CREATE UNIQUE INDEX idx_identity_link_active_cloudflare_identity
  ON tenant_identity_link_requests(tenant_id, cloudflare_issuer, cloudflare_subject)
  WHERE status = 'approved';
