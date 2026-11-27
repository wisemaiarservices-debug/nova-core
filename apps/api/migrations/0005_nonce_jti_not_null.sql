-- NOVA Core nonce key integrity hardening — 0005
-- SQLite rowid tables can accept NULL in a TEXT PRIMARY KEY unless NOT NULL
-- is explicit. Rebuild the nonce table so every durable replay record has a
-- usable, unique assertion ID. Null-key rows cannot identify a valid request
-- and cannot be selected by the bounded cleanup query, so discard them.
-- This migration preserves all valid keyed records and the retention index.

DELETE FROM internal_request_nonces
WHERE jti IS NULL;

CREATE TABLE internal_request_nonces_hardened (
  jti TEXT NOT NULL PRIMARY KEY
    CHECK (length(trim(jti)) BETWEEN 16 AND 128 AND jti = trim(jti)),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  retained_until INTEGER NOT NULL CHECK (retained_until >= expires_at),
  consumed_at INTEGER NOT NULL CHECK (consumed_at > 0)
);

INSERT INTO internal_request_nonces_hardened (
  jti, expires_at, retained_until, consumed_at
)
SELECT jti, expires_at, retained_until, consumed_at
FROM internal_request_nonces;

DROP TABLE internal_request_nonces;

ALTER TABLE internal_request_nonces_hardened
RENAME TO internal_request_nonces;

CREATE INDEX idx_internal_request_nonces_retention
  ON internal_request_nonces(retained_until);
