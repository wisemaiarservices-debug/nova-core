-- NOVA Core identity-link challenge rate limits — 0025
-- Store only SHA-256 identity digests, never issuer/subject values.
-- Fixed 15-minute windows; stale rows are pruned by the request path.

CREATE TABLE tenant_identity_link_rate_limits (
  identity_digest TEXT NOT NULL CHECK (
    length(identity_digest) = 64 AND identity_digest NOT GLOB '*[^a-f0-9]*'
  ),
  operation TEXT NOT NULL CHECK (operation IN ('challenge_create', 'challenge_consume')),
  window_started_at INTEGER NOT NULL CHECK (window_started_at >= 0),
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 1000),
  PRIMARY KEY (identity_digest, operation, window_started_at)
) WITHOUT ROWID;

CREATE INDEX idx_identity_link_rate_limits_window
  ON tenant_identity_link_rate_limits(window_started_at);
