-- NOVA site configuration reviewer assignments and append-only provenance — 0009
-- Provisioning is tenant/site scoped. This migration creates no reviewer identities.
PRAGMA foreign_keys = ON;

CREATE TABLE tenant_site_configuration_reviewers (
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  reviewer_subject TEXT NOT NULL CHECK (length(trim(reviewer_subject)) BETWEEN 1 AND 200),
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('engineering_reviewer', 'operations_reviewer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  assigned_by_subject TEXT NOT NULL CHECK (length(trim(assigned_by_subject)) BETWEEN 1 AND 200),
  assignment_evidence_ref TEXT NOT NULL CHECK (length(trim(assignment_evidence_ref)) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, site_id, reviewer_subject, reviewer_role),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX idx_site_configuration_reviewers_active
  ON tenant_site_configuration_reviewers(tenant_id, site_id, reviewer_role, status);

CREATE TABLE tenant_site_configuration_reviewer_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  reviewer_subject TEXT NOT NULL,
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('engineering_reviewer', 'operations_reviewer')),
  event_type TEXT NOT NULL CHECK (event_type IN ('assigned', 'revoked')),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, site_id, reviewer_subject, reviewer_role)
    REFERENCES tenant_site_configuration_reviewers(tenant_id, site_id, reviewer_subject, reviewer_role)
    ON DELETE RESTRICT
);
CREATE INDEX idx_site_configuration_reviewer_events_history
  ON tenant_site_configuration_reviewer_events(tenant_id, site_id, reviewer_subject, occurred_at);

CREATE TRIGGER site_configuration_reviewer_event_state_guard
BEFORE INSERT ON tenant_site_configuration_reviewer_events
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_site_configuration_reviewers r
  JOIN tenants t ON t.id = r.tenant_id AND t.status = 'active'
  WHERE r.tenant_id = NEW.tenant_id AND r.site_id = NEW.site_id
    AND r.reviewer_subject = NEW.reviewer_subject AND r.reviewer_role = NEW.reviewer_role
    AND ((NEW.event_type = 'assigned' AND r.status = 'active')
      OR (NEW.event_type = 'revoked' AND r.status = 'revoked'))
)
BEGIN SELECT RAISE(ABORT, 'site configuration reviewer event must match active tenant and assignment state'); END;

CREATE TRIGGER site_configuration_reviewer_assignment_evidence_immutable
BEFORE UPDATE OF assigned_by_subject, assignment_evidence_ref, created_at
ON tenant_site_configuration_reviewers
WHEN NEW.assigned_by_subject IS NOT OLD.assigned_by_subject
  OR NEW.assignment_evidence_ref IS NOT OLD.assignment_evidence_ref
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'site configuration reviewer assignment evidence is immutable'); END;

CREATE TRIGGER site_configuration_reviewer_revocation_terminal
BEFORE UPDATE OF status ON tenant_site_configuration_reviewers
WHEN OLD.status = 'revoked' AND NEW.status <> 'revoked'
BEGIN SELECT RAISE(ABORT, 'revoked site configuration reviewer cannot be reactivated'); END;

CREATE TRIGGER site_configuration_reviewer_events_immutable_update
BEFORE UPDATE ON tenant_site_configuration_reviewer_events
BEGIN SELECT RAISE(ABORT, 'site configuration reviewer history is immutable'); END;
CREATE TRIGGER site_configuration_reviewer_events_immutable_delete
BEFORE DELETE ON tenant_site_configuration_reviewer_events
BEGIN SELECT RAISE(ABORT, 'site configuration reviewer history cannot be deleted'); END;
