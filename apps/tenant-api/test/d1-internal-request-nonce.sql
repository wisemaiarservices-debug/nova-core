-- Exercise the production nonce INSERT conflict target against real local D1.
-- The fixed CI-only identifier is isolated to the disposable database.
INSERT INTO internal_request_nonces (request_id, issued_at, expires_at)
VALUES ('nova-ci-nonce-unique-constraint', 1900000000, 1900000600)
ON CONFLICT(request_id) DO NOTHING;

INSERT INTO internal_request_nonces (request_id, issued_at, expires_at)
VALUES ('nova-ci-nonce-unique-constraint', 1900000001, 1900000601)
ON CONFLICT(request_id) DO NOTHING;

-- A CHECK failure makes this SQL step fail if duplicate consumption was accepted.
CREATE TEMP TABLE nonce_uniqueness_assertion (
  passed INTEGER NOT NULL CHECK (passed = 1)
);
INSERT INTO nonce_uniqueness_assertion (passed)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM internal_request_nonces
WHERE request_id = 'nova-ci-nonce-unique-constraint';

-- Keep the disposable fixture tidy for subsequent integration tests.
DELETE FROM internal_request_nonces
WHERE request_id = 'nova-ci-nonce-unique-constraint';
