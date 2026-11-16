-- Bind Core tenant provisioning idempotency to the verified NOVA OS and Supabase identities.
-- Historical Access-only records remain readable with all binding columns NULL.
ALTER TABLE tenant_provisioning_requests ADD COLUMN supabase_issuer TEXT;
ALTER TABLE tenant_provisioning_requests ADD COLUMN supabase_subject TEXT;
ALTER TABLE tenant_provisioning_requests ADD COLUMN nova_os_tenant_id TEXT;
ALTER TABLE tenant_provisioning_requests ADD COLUMN nova_os_assertion_jti TEXT;
ALTER TABLE tenant_provisioning_requests ADD COLUMN nova_os_receipt_jti TEXT;

CREATE TRIGGER tenant_provisioning_requests_identity_binding_check
BEFORE INSERT ON tenant_provisioning_requests
WHEN NOT (
  (NEW.supabase_issuer IS NULL AND NEW.supabase_subject IS NULL AND NEW.nova_os_tenant_id IS NULL AND NEW.nova_os_assertion_jti IS NULL AND NEW.nova_os_receipt_jti IS NULL)
  OR (
    NEW.supabase_issuer IS NOT NULL
    AND length(trim(NEW.supabase_issuer)) BETWEEN 1 AND 500
    AND NEW.supabase_issuer = trim(NEW.supabase_issuer)
    AND NEW.supabase_subject IS NOT NULL
    AND length(trim(NEW.supabase_subject)) BETWEEN 1 AND 200
    AND NEW.supabase_subject = trim(NEW.supabase_subject)
    AND NEW.nova_os_tenant_id IS NOT NULL
    AND length(NEW.nova_os_tenant_id) BETWEEN 1 AND 120
    AND NEW.nova_os_tenant_id = trim(NEW.nova_os_tenant_id)
    AND substr(NEW.nova_os_tenant_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND NEW.nova_os_tenant_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND NEW.nova_os_assertion_jti IS NOT NULL
    AND length(trim(NEW.nova_os_assertion_jti)) BETWEEN 1 AND 200
    AND NEW.nova_os_assertion_jti = trim(NEW.nova_os_assertion_jti)
    AND NEW.nova_os_receipt_jti IS NOT NULL
    AND length(trim(NEW.nova_os_receipt_jti)) BETWEEN 1 AND 200
    AND NEW.nova_os_receipt_jti = trim(NEW.nova_os_receipt_jti)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'tenant provisioning identity binding is incomplete or invalid');
END;

-- A NOVA OS tenant can be provisioned into Core only once, even if a caller
-- changes its idempotency key. The mapping write itself is handled separately.
CREATE UNIQUE INDEX idx_tenant_provisioning_requests_nova_os_tenant
  ON tenant_provisioning_requests(nova_os_tenant_id)
  WHERE nova_os_tenant_id IS NOT NULL;

CREATE UNIQUE INDEX idx_tenant_provisioning_requests_owner_assertion_jti
  ON tenant_provisioning_requests(nova_os_assertion_jti)
  WHERE nova_os_assertion_jti IS NOT NULL;

CREATE UNIQUE INDEX idx_tenant_provisioning_requests_receipt_jti
  ON tenant_provisioning_requests(nova_os_receipt_jti)
  WHERE nova_os_receipt_jti IS NOT NULL;
