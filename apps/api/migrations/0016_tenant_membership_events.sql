-- NOVA Core immutable tenant membership lifecycle events — 0016
-- Apply after 0015_measurement_quality_engine.sql.
-- Event rows are written by the private Tenant API in the same D1 batch as
-- membership changes. No browser-facing database access is introduced.

CREATE TABLE tenant_membership_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 200),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'role_changed', 'suspended', 'revoked', 'reactivated'
  )),
  previous_role TEXT CHECK (previous_role IS NULL OR previous_role IN (
    'tenant_owner', 'tenant_admin', 'operator', 'analyst', 'viewer', 'service'
  )),
  new_role TEXT CHECK (new_role IS NULL OR new_role IN (
    'tenant_owner', 'tenant_admin', 'operator', 'analyst', 'viewer', 'service'
  )),
  previous_status TEXT CHECK (previous_status IS NULL OR previous_status IN ('active', 'inactive', 'revoked')),
  new_status TEXT NOT NULL CHECK (new_status IN ('active', 'inactive', 'revoked')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (membership_id, tenant_id) REFERENCES tenant_memberships(id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (event_type = 'created' AND previous_role IS NULL AND previous_status IS NULL
      AND new_status = 'active')
    OR (event_type = 'role_changed' AND previous_role IS NOT NULL
      AND previous_status IS NOT NULL AND previous_role <> new_role
      AND previous_status = new_status)
    OR (event_type = 'suspended' AND previous_role IS NOT NULL
      AND previous_status = 'active' AND new_status = 'inactive'
      AND previous_role = new_role)
    OR (event_type = 'revoked' AND previous_role IS NOT NULL
      AND previous_status IN ('active', 'inactive') AND new_status = 'revoked'
      AND previous_role = new_role)
    OR (event_type = 'reactivated' AND previous_role IS NOT NULL
      AND previous_status = 'inactive' AND new_status = 'active'
      AND previous_role = new_role)
  )
);

CREATE INDEX idx_tenant_membership_events_timeline
  ON tenant_membership_events(tenant_id, membership_id, created_at DESC);
CREATE INDEX idx_tenant_membership_events_subject
  ON tenant_membership_events(tenant_id, subject, created_at DESC);

-- An event must describe the current membership pre-state. For creation, the
-- membership row is inserted first and the matching creation event follows in
-- the same atomic D1 batch.
CREATE TRIGGER tenant_membership_event_prestate_guard
BEFORE INSERT ON tenant_membership_events
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_memberships m
  WHERE m.id = NEW.membership_id
    AND m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.subject
    AND (
      (NEW.event_type = 'created'
        AND NEW.previous_role IS NULL AND NEW.previous_status IS NULL
        AND m.role = NEW.new_role AND m.status = NEW.new_status)
      OR
      (NEW.event_type <> 'created'
        AND m.role = NEW.previous_role AND m.status = NEW.previous_status)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'membership event does not match membership pre-state');
END;

-- Every role/status update must be paired with an event describing the exact
-- old and new state. The API inserts the event before the update in one batch.
CREATE TRIGGER tenant_membership_update_requires_event
BEFORE UPDATE OF role, status ON tenant_memberships
WHEN (NEW.role IS NOT OLD.role OR NEW.status IS NOT OLD.status)
  AND NOT EXISTS (
    SELECT 1 FROM tenant_membership_events e
    WHERE e.tenant_id = OLD.tenant_id
      AND e.membership_id = OLD.id
      AND e.subject = OLD.subject
      AND e.previous_role = OLD.role
      AND e.new_role = NEW.role
      AND e.previous_status = OLD.status
      AND e.new_status = NEW.status
      AND e.event_type IN ('role_changed', 'suspended', 'revoked', 'reactivated')
  )
BEGIN
  SELECT RAISE(ABORT, 'membership update requires a matching immutable event');
END;

-- Never remove or demote the final active tenant owner.
CREATE TRIGGER tenant_membership_last_owner_guard
BEFORE UPDATE OF role, status ON tenant_memberships
WHEN OLD.role = 'tenant_owner' AND OLD.status = 'active'
  AND (NEW.role <> 'tenant_owner' OR NEW.status <> 'active')
  AND (
    SELECT COUNT(*) FROM tenant_memberships m
    WHERE m.tenant_id = OLD.tenant_id
      AND m.role = 'tenant_owner' AND m.status = 'active'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot remove or demote the last active tenant owner');
END;

CREATE TRIGGER tenant_membership_events_no_update
BEFORE UPDATE ON tenant_membership_events
BEGIN
  SELECT RAISE(ABORT, 'tenant membership events are append-only');
END;

CREATE TRIGGER tenant_membership_events_no_delete
BEFORE DELETE ON tenant_membership_events
BEGIN
  SELECT RAISE(ABORT, 'tenant membership events are append-only');
END;
