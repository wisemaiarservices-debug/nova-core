-- Enforce the source lifecycle gate at the observation write boundary.
-- The ingestion Worker performs an early authorization/ownership lookup, but that
-- lookup is separate from persistence. This trigger closes the revocation race.
CREATE TRIGGER observations_require_verified_source_insert_guard
BEFORE INSERT ON observations
WHEN NOT EXISTS (
  SELECT 1
  FROM sources src
  JOIN tenants t ON t.id = src.tenant_id AND t.status = 'active'
  JOIN sites s ON s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id AND s.status = 'active'
  WHERE src.id = NEW.source_id
    AND src.tenant_id = NEW.tenant_id
    AND src.module = NEW.module
    AND src.verification_status = 'verified'
    AND (src.site_id IS NULL OR src.site_id = NEW.site_id)
)
BEGIN
  SELECT RAISE(ABORT, 'observation ingestion requires an active tenant, active site and verified matching source');
END;
