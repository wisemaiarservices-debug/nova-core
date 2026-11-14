-- NOVA Core cross-system identity-link challenge and approval ledger — 0022
-- Schema foundation only. No endpoint or automatic identity federation is enabled.

CREATE TABLE tenant_identity_link_challenges (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  supabase_issuer TEXT NOT NULL CHECK (length(trim(supabase_issuer)) BETWEEN 1 AND 500),
  supabase_subject TEXT NOT NULL CHECK (length(trim(supabase_subject)) BETWEEN 1 AND 200),
  cloudflare_issuer TEXT NOT NULL CHECK (length(trim(cloudflare_issuer)) BETWEEN 1 AND 500),
  cloudflare_subject TEXT NOT NULL CHECK (length(trim(cloudflare_subject)) BETWEEN 1 AND 200),
  challenge_sha256 TEXT NOT NULL UNIQUE CHECK (length(challenge_sha256) = 64 AND challenge_sha256 NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  CHECK (expires_at > created_at),
  CHECK ((status = 'pending' AND consumed_at IS NULL) OR
         (status = 'consumed' AND consumed_at IS NOT NULL) OR
         (status = 'expired' AND consumed_at IS NULL))
);
CREATE INDEX idx_identity_link_challenges_expiry
  ON tenant_identity_link_challenges(status, expires_at);

CREATE TABLE tenant_identity_link_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  challenge_id TEXT NOT NULL UNIQUE,
  supabase_issuer TEXT NOT NULL,
  supabase_subject TEXT NOT NULL,
  cloudflare_issuer TEXT NOT NULL,
  cloudflare_subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  tenant_id TEXT,
  decided_by_cloudflare_issuer TEXT,
  decided_by_cloudflare_subject TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  FOREIGN KEY (challenge_id) REFERENCES tenant_identity_link_challenges(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CHECK (
    (status = 'pending' AND tenant_id IS NULL AND decided_by_cloudflare_issuer IS NULL
      AND decided_by_cloudflare_subject IS NULL AND reason IS NULL AND decided_at IS NULL)
    OR
    (status IN ('approved', 'rejected', 'revoked') AND tenant_id IS NOT NULL
      AND decided_by_cloudflare_issuer IS NOT NULL AND decided_by_cloudflare_subject IS NOT NULL
      AND reason IS NOT NULL AND length(trim(reason)) BETWEEN 1 AND 1000 AND decided_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_identity_link_pending_pair
  ON tenant_identity_link_requests(supabase_issuer, supabase_subject, cloudflare_issuer, cloudflare_subject)
  WHERE status = 'pending';
CREATE INDEX idx_identity_link_requests_tenant
  ON tenant_identity_link_requests(tenant_id, status, created_at DESC);

CREATE TABLE tenant_identity_link_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  link_request_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('requested', 'approved', 'rejected', 'revoked')),
  previous_status TEXT,
  new_status TEXT NOT NULL CHECK (new_status IN ('pending', 'approved', 'rejected', 'revoked')),
  tenant_id TEXT,
  actor_cloudflare_issuer TEXT NOT NULL CHECK (length(trim(actor_cloudflare_issuer)) BETWEEN 1 AND 500),
  actor_cloudflare_subject TEXT NOT NULL CHECK (length(trim(actor_cloudflare_subject)) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (link_request_id) REFERENCES tenant_identity_link_requests(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CHECK (
    (event_type = 'requested' AND previous_status IS NULL AND new_status = 'pending' AND tenant_id IS NULL)
    OR (event_type = 'approved' AND previous_status = 'pending' AND new_status = 'approved' AND tenant_id IS NOT NULL)
    OR (event_type = 'rejected' AND previous_status = 'pending' AND new_status = 'rejected' AND tenant_id IS NOT NULL)
    OR (event_type = 'revoked' AND previous_status = 'approved' AND new_status = 'revoked' AND tenant_id IS NOT NULL)
  )
);
CREATE INDEX idx_identity_link_events_timeline
  ON tenant_identity_link_events(link_request_id, created_at DESC, id DESC);

-- A challenge can only be consumed once. All identity claims and its digest
-- are immutable, and only the pending -> consumed/expired transitions exist.
CREATE TRIGGER identity_link_challenge_update_guard
BEFORE UPDATE ON tenant_identity_link_challenges
WHEN NEW.id IS NOT OLD.id OR NEW.supabase_issuer IS NOT OLD.supabase_issuer
  OR NEW.supabase_subject IS NOT OLD.supabase_subject
  OR NEW.cloudflare_issuer IS NOT OLD.cloudflare_issuer
  OR NEW.cloudflare_subject IS NOT OLD.cloudflare_subject
  OR NEW.challenge_sha256 IS NOT OLD.challenge_sha256
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.request_id IS NOT OLD.request_id
  OR NOT (
    OLD.status = 'pending' AND (
      (NEW.status = 'consumed' AND NEW.consumed_at IS NOT NULL
        AND NEW.consumed_at >= OLD.created_at AND NEW.consumed_at < OLD.expires_at)
      OR (NEW.status = 'expired' AND NEW.consumed_at IS NULL)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid or immutable identity-link challenge transition');
END;
CREATE TRIGGER identity_link_challenges_no_delete
BEFORE DELETE ON tenant_identity_link_challenges
BEGIN
  SELECT RAISE(ABORT, 'identity-link challenges are immutable');
END;

-- A request can only be created from a consumed challenge whose two verified
-- issuer/subject pairs match exactly. The raw challenge is never stored.
CREATE TRIGGER identity_link_request_challenge_guard
BEFORE INSERT ON tenant_identity_link_requests
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_identity_link_challenges c
  WHERE c.id = NEW.challenge_id AND c.status = 'consumed'
    AND c.supabase_issuer = NEW.supabase_issuer AND c.supabase_subject = NEW.supabase_subject
    AND c.cloudflare_issuer = NEW.cloudflare_issuer AND c.cloudflare_subject = NEW.cloudflare_subject
)
BEGIN
  SELECT RAISE(ABORT, 'identity-link request requires matching consumed challenge');
END;

CREATE TRIGGER identity_link_event_prestate_guard
BEFORE INSERT ON tenant_identity_link_events
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_identity_link_requests r
  WHERE r.id = NEW.link_request_id
    AND (
      (NEW.event_type = 'requested' AND r.status = 'pending' AND NEW.previous_status IS NULL
        AND NEW.new_status = 'pending' AND NEW.tenant_id IS NULL
        AND r.cloudflare_issuer = NEW.actor_cloudflare_issuer
        AND r.cloudflare_subject = NEW.actor_cloudflare_subject)
      OR
      (NEW.event_type IN ('approved', 'rejected') AND r.status = 'pending'
        AND NEW.previous_status = 'pending' AND NEW.new_status = NEW.event_type
        AND r.tenant_id IS NULL AND r.cloudflare_issuer = NEW.actor_cloudflare_issuer
        AND r.cloudflare_subject <> NEW.actor_cloudflare_subject AND EXISTS (
          SELECT 1 FROM tenants t JOIN tenant_memberships m ON m.tenant_id = t.id
          WHERE t.id = NEW.tenant_id AND t.status = 'active'
            AND m.subject = NEW.actor_cloudflare_subject AND m.role = 'tenant_owner'
            AND m.status = 'active'
        ))
      OR
      (NEW.event_type = 'revoked' AND r.status = 'approved'
        AND NEW.previous_status = 'approved' AND NEW.new_status = 'revoked'
        AND r.tenant_id = NEW.tenant_id AND r.cloudflare_issuer = NEW.actor_cloudflare_issuer AND EXISTS (
          SELECT 1 FROM tenants t JOIN tenant_memberships m ON m.tenant_id = t.id
          WHERE t.id = NEW.tenant_id AND t.status = 'active'
            AND m.subject = NEW.actor_cloudflare_subject AND m.role = 'tenant_owner'
            AND m.status = 'active'
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'identity-link event does not match request pre-state or owner authority');
END;

CREATE TRIGGER identity_link_request_update_requires_event
BEFORE UPDATE ON tenant_identity_link_requests
WHEN NEW.id IS NOT OLD.id OR NEW.challenge_id IS NOT OLD.challenge_id
  OR NEW.supabase_issuer IS NOT OLD.supabase_issuer OR NEW.supabase_subject IS NOT OLD.supabase_subject
  OR NEW.cloudflare_issuer IS NOT OLD.cloudflare_issuer OR NEW.cloudflare_subject IS NOT OLD.cloudflare_subject
  OR NEW.created_at IS NOT OLD.created_at OR NEW.request_id IS NOT OLD.request_id
  OR NOT EXISTS (
    SELECT 1 FROM tenant_identity_link_events e
    WHERE e.link_request_id = OLD.id AND e.previous_status = OLD.status
      AND e.new_status = NEW.status AND e.tenant_id = NEW.tenant_id
      AND e.actor_cloudflare_issuer = NEW.decided_by_cloudflare_issuer
      AND e.actor_cloudflare_subject = NEW.decided_by_cloudflare_subject
      AND e.reason = NEW.reason AND e.event_type = NEW.status
      AND OLD.status IN ('pending', 'approved')
  )
  OR NOT (
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')
      AND NEW.tenant_id IS NOT NULL AND NEW.decided_by_cloudflare_issuer IS NOT NULL
      AND NEW.decided_by_cloudflare_subject IS NOT NULL AND NEW.reason IS NOT NULL
      AND NEW.decided_at IS NOT NULL)
    OR (OLD.status = 'approved' AND NEW.status = 'revoked'
      AND NEW.tenant_id = OLD.tenant_id AND NEW.decided_by_cloudflare_issuer IS NOT NULL
      AND NEW.decided_by_cloudflare_subject IS NOT NULL AND NEW.reason IS NOT NULL
      AND NEW.decided_at IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'identity-link request update requires matching immutable owner event');
END;

CREATE TRIGGER identity_link_requests_no_delete
BEFORE DELETE ON tenant_identity_link_requests
BEGIN
  SELECT RAISE(ABORT, 'identity-link requests are immutable');
END;
CREATE TRIGGER identity_link_events_no_update
BEFORE UPDATE ON tenant_identity_link_events
BEGIN
  SELECT RAISE(ABORT, 'identity-link events are append-only');
END;
CREATE TRIGGER identity_link_events_no_delete
BEFORE DELETE ON tenant_identity_link_events
BEGIN
  SELECT RAISE(ABORT, 'identity-link events are append-only');
END;
