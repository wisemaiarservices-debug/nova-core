-- Persist the exact NOVA OS one-time authorization permit claims with the
-- durable Core provisioning request. Existing historical rows remain readable;
-- every new NOVA OS-bound provisioning insert must include a verified permit.

ALTER TABLE tenant_provisioning_requests ADD COLUMN access_issuer TEXT;
ALTER TABLE tenant_provisioning_requests ADD COLUMN nova_os_authorization_permit_jti TEXT;
ALTER TABLE tenant_provisioning_requests ADD COLUMN nova_os_authorization_permit_issuer TEXT;
ALTER TABLE tenant_provisioning_requests ADD COLUMN nova_os_authorization_permit_audience TEXT;
ALTER TABLE tenant_provisioning_requests ADD COLUMN nova_os_authorization_permit_key_id TEXT;
ALTER TABLE tenant_provisioning_requests ADD COLUMN nova_os_authorization_correlation_id TEXT;
ALTER TABLE tenant_provisioning_requests ADD COLUMN nova_os_authorization_permit_issued_at INTEGER;
ALTER TABLE tenant_provisioning_requests ADD COLUMN nova_os_authorization_permit_expires_at INTEGER;

CREATE UNIQUE INDEX idx_tenant_provisioning_requests_authorization_permit_jti
  ON tenant_provisioning_requests(nova_os_authorization_permit_jti)
  WHERE nova_os_authorization_permit_jti IS NOT NULL;

CREATE TRIGGER tenant_provisioning_requests_authorization_permit_check
BEFORE INSERT ON tenant_provisioning_requests
WHEN NEW.nova_os_tenant_id IS NOT NULL AND NOT (
  NEW.access_issuer IS NOT NULL
  AND length(trim(NEW.access_issuer)) BETWEEN 9 AND 500
  AND NEW.access_issuer = trim(NEW.access_issuer)
  AND substr(NEW.access_issuer, 1, 8) = 'https://'
  AND NEW.nova_os_authorization_permit_jti IS NOT NULL
  AND length(NEW.nova_os_authorization_permit_jti) = 36
  AND substr(NEW.nova_os_authorization_permit_jti, 9, 1) = '-'
  AND substr(NEW.nova_os_authorization_permit_jti, 14, 1) = '-'
  AND substr(NEW.nova_os_authorization_permit_jti, 19, 1) = '-'
  AND substr(NEW.nova_os_authorization_permit_jti, 24, 1) = '-'
  AND lower(replace(NEW.nova_os_authorization_permit_jti, '-', '')) NOT GLOB '*[^0-9a-f]*'
  AND NEW.nova_os_authorization_permit_issuer IS NOT NULL
  AND length(trim(NEW.nova_os_authorization_permit_issuer)) BETWEEN 1 AND 500
  AND NEW.nova_os_authorization_permit_issuer = trim(NEW.nova_os_authorization_permit_issuer)
  AND substr(NEW.nova_os_authorization_permit_issuer, 1, 8) = 'https://'
  AND NEW.nova_os_authorization_permit_audience IS NOT NULL
  AND length(trim(NEW.nova_os_authorization_permit_audience)) BETWEEN 1 AND 256
  AND NEW.nova_os_authorization_permit_audience = trim(NEW.nova_os_authorization_permit_audience)
  AND NEW.nova_os_authorization_permit_key_id IS NOT NULL
  AND length(NEW.nova_os_authorization_permit_key_id) BETWEEN 1 AND 80
  AND NEW.nova_os_authorization_permit_key_id NOT GLOB '*[^A-Za-z0-9._-]*'
  AND NEW.nova_os_authorization_correlation_id = 'nova-provision:' || NEW.request_sha256
  AND typeof(NEW.nova_os_authorization_permit_issued_at) = 'integer'
  AND typeof(NEW.nova_os_authorization_permit_expires_at) = 'integer'
  AND NEW.nova_os_authorization_permit_expires_at > NEW.nova_os_authorization_permit_issued_at
  AND NEW.nova_os_authorization_permit_expires_at - NEW.nova_os_authorization_permit_issued_at BETWEEN 1 AND 120
)
BEGIN
  SELECT RAISE(ABORT, 'NOVA OS authorization permit binding is incomplete or invalid');
END;

CREATE TRIGGER tenant_provisioning_requests_authorization_permit_immutable
BEFORE UPDATE OF access_issuer, nova_os_authorization_permit_jti,
  nova_os_authorization_permit_issuer, nova_os_authorization_permit_audience,
  nova_os_authorization_permit_key_id, nova_os_authorization_correlation_id,
  nova_os_authorization_permit_issued_at, nova_os_authorization_permit_expires_at
ON tenant_provisioning_requests
WHEN OLD.nova_os_authorization_permit_jti IS NOT NULL AND (
  NEW.access_issuer IS NOT OLD.access_issuer OR
  NEW.nova_os_authorization_permit_jti IS NOT OLD.nova_os_authorization_permit_jti OR
  NEW.nova_os_authorization_permit_issuer IS NOT OLD.nova_os_authorization_permit_issuer OR
  NEW.nova_os_authorization_permit_audience IS NOT OLD.nova_os_authorization_permit_audience OR
  NEW.nova_os_authorization_permit_key_id IS NOT OLD.nova_os_authorization_permit_key_id OR
  NEW.nova_os_authorization_correlation_id IS NOT OLD.nova_os_authorization_correlation_id OR
  NEW.nova_os_authorization_permit_issued_at IS NOT OLD.nova_os_authorization_permit_issued_at OR
  NEW.nova_os_authorization_permit_expires_at IS NOT OLD.nova_os_authorization_permit_expires_at
)
BEGIN
  SELECT RAISE(ABORT, 'NOVA OS authorization permit binding is immutable');
END;
