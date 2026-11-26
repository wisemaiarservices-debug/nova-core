-- Durable one-time request nonce store for the private tenant API.
-- This migration is additive and must only be applied to a disposable/staging D1
-- database after the tenant schema and replay integration have been reviewed.
-- Retain consumed IDs beyond assertion expiry to prevent short-window reuse.

CREATE TABLE IF NOT EXISTS internal_request_nonces (
  jti TEXT PRIMARY KEY
    CHECK (length(trim(jti)) BETWEEN 16 AND 128 AND jti = trim(jti)),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  retained_until INTEGER NOT NULL CHECK (retained_until >= expires_at),
  consumed_at INTEGER NOT NULL CHECK (consumed_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_internal_request_nonces_retention
  ON internal_request_nonces(retained_until);
