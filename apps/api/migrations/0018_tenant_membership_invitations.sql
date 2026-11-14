-- NOVA Core possession-based tenant membership invitations — 0018
-- Invitation tokens are one-time bearer secrets. The accepted membership
-- subject is always the verified Access subject from the acceptance request.

CREATE TABLE tenant_membership_invitations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('tenant_admin', 'operator', 'analyst', 'viewer')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^a-f0-9]*'),
  created_by_subject TEXT NOT NULL CHECK (length(trim(created_by_subject)) BETWEEN 1 AND 200),
  accepted_by_subject TEXT CHECK (accepted_by_subject IS NULL OR length(trim(accepted_by_subject)) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CHECK (
    (status = 'pending' AND accepted_by_subject IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
    OR (status = 'accepted' AND accepted_by_subject IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND accepted_by_subject IS NULL AND accepted_at IS NULL AND revoked_at IS NOT NULL)
    OR (status = 'expired' AND accepted_by_subject IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
  )
);
CREATE INDEX idx_tenant_membership_invitations_pending
  ON tenant_membership_invitations(tenant_id, status, expires_at);

CREATE TABLE tenant_membership_invitation_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'accepted', 'revoked', 'expired')),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  subject TEXT CHECK (subject IS NULL OR length(trim(subject)) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (invitation_id) REFERENCES tenant_membership_invitations(id) ON DELETE RESTRICT
);
CREATE INDEX idx_tenant_membership_invitation_events
  ON tenant_membership_invitation_events(tenant_id, invitation_id, created_at DESC);

CREATE TRIGGER tenant_membership_invitation_events_state_guard
BEFORE INSERT ON tenant_membership_invitation_events
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_membership_invitations i
  WHERE i.id = NEW.invitation_id AND i.tenant_id = NEW.tenant_id
    AND (
      (NEW.event_type = 'created' AND i.status = 'pending' AND NEW.subject IS NULL)
      OR (NEW.event_type = 'accepted' AND i.status = 'accepted'
        AND i.accepted_by_subject = NEW.subject AND i.accepted_by_subject = NEW.actor_subject)
      OR (NEW.event_type = 'revoked' AND i.status = 'revoked' AND NEW.subject IS NULL)
      OR (NEW.event_type = 'expired' AND i.status = 'expired' AND NEW.subject IS NULL)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'membership invitation event does not match invitation state');
END;

CREATE TRIGGER tenant_membership_invitations_update_guard
BEFORE UPDATE ON tenant_membership_invitations
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR
  NEW.role IS NOT OLD.role OR NEW.token_sha256 IS NOT OLD.token_sha256 OR
  NEW.created_by_subject IS NOT OLD.created_by_subject OR NEW.reason IS NOT OLD.reason OR
  NEW.request_id IS NOT OLD.request_id OR NEW.created_at IS NOT OLD.created_at OR
  NEW.expires_at IS NOT OLD.expires_at OR
  NOT (
    (OLD.status = 'pending' AND NEW.status = 'accepted'
      AND NEW.accepted_by_subject IS NOT NULL AND NEW.accepted_at IS NOT NULL AND NEW.revoked_at IS NULL)
    OR (OLD.status = 'pending' AND NEW.status = 'revoked'
      AND NEW.accepted_by_subject IS NULL AND NEW.accepted_at IS NULL AND NEW.revoked_at IS NOT NULL)
    OR (OLD.status = 'pending' AND NEW.status = 'expired'
      AND NEW.accepted_by_subject IS NULL AND NEW.accepted_at IS NULL AND NEW.revoked_at IS NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid or immutable membership invitation transition');
END;

CREATE TRIGGER tenant_membership_invitations_no_delete
BEFORE DELETE ON tenant_membership_invitations
BEGIN
  SELECT RAISE(ABORT, 'tenant membership invitations are immutable');
END;

CREATE TRIGGER tenant_membership_invitation_events_no_update
BEFORE UPDATE ON tenant_membership_invitation_events
BEGIN
  SELECT RAISE(ABORT, 'tenant membership invitation events are append-only');
END;

CREATE TRIGGER tenant_membership_invitation_events_no_delete
BEFORE DELETE ON tenant_membership_invitation_events
BEGIN
  SELECT RAISE(ABORT, 'tenant membership invitation events are append-only');
END;
