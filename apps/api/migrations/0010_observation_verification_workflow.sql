-- Governed tenant/site-scoped human verification for persisted observations.
-- Human review is a provenance control, not proof of scientific accuracy.
PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX idx_observations_id_tenant_site
  ON observations(id, tenant_id, site_id);

CREATE TABLE observation_reviewers (
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  reviewer_subject TEXT NOT NULL CHECK (length(trim(reviewer_subject)) BETWEEN 1 AND 200),
  reviewer_role TEXT NOT NULL CHECK (reviewer_role = 'measurement_reviewer'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  assigned_by_subject TEXT NOT NULL CHECK (length(trim(assigned_by_subject)) BETWEEN 1 AND 200),
  assignment_evidence_ref TEXT NOT NULL CHECK (length(trim(assignment_evidence_ref)) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, site_id, reviewer_subject, reviewer_role),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX idx_observation_reviewers_active
  ON observation_reviewers(tenant_id, site_id, status, reviewer_role);

CREATE TABLE observation_reviewer_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  reviewer_subject TEXT NOT NULL,
  reviewer_role TEXT NOT NULL CHECK (reviewer_role = 'measurement_reviewer'),
  event_type TEXT NOT NULL CHECK (event_type IN ('assigned', 'revoked')),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, site_id, reviewer_subject, reviewer_role)
    REFERENCES observation_reviewers(tenant_id, site_id, reviewer_subject, reviewer_role) ON DELETE RESTRICT
);
CREATE INDEX idx_observation_reviewer_events_history
  ON observation_reviewer_events(tenant_id, site_id, reviewer_subject, occurred_at);

CREATE TABLE observation_verification_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  reviewer_subject TEXT NOT NULL,
  reviewer_role TEXT NOT NULL CHECK (reviewer_role = 'measurement_reviewer'),
  event_type TEXT NOT NULL CHECK (event_type IN ('verified', 'rejected', 'revoked')),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (observation_id, tenant_id, site_id)
    REFERENCES observations(id, tenant_id, site_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, site_id, reviewer_subject, reviewer_role)
    REFERENCES observation_reviewers(tenant_id, site_id, reviewer_subject, reviewer_role) ON DELETE RESTRICT
);
CREATE INDEX idx_observation_verification_events_history
  ON observation_verification_events(tenant_id, site_id, observation_id, occurred_at);

CREATE TRIGGER observation_reviewer_active_tenant_guard
BEFORE INSERT ON observation_reviewers
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN SELECT RAISE(ABORT, 'reviewer assignment requires an active tenant'); END;
CREATE TRIGGER observation_reviewer_scope_immutable_guard
BEFORE UPDATE OF tenant_id, site_id, reviewer_subject, reviewer_role,
  assigned_by_subject, assignment_evidence_ref, created_at ON observation_reviewers
WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.site_id IS NOT OLD.site_id
  OR NEW.reviewer_subject IS NOT OLD.reviewer_subject OR NEW.reviewer_role IS NOT OLD.reviewer_role
  OR NEW.assigned_by_subject IS NOT OLD.assigned_by_subject
  OR NEW.assignment_evidence_ref IS NOT OLD.assignment_evidence_ref
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'reviewer identity, scope and assignment evidence are immutable'); END;
CREATE TRIGGER observation_reviewer_revocation_terminal_guard
BEFORE UPDATE OF status ON observation_reviewers
WHEN OLD.status = 'revoked' AND NEW.status <> 'revoked'
BEGIN SELECT RAISE(ABORT, 'revoked reviewer assignments cannot be reactivated'); END;
CREATE TRIGGER observation_reviewer_delete_guard
BEFORE DELETE ON observation_reviewers
BEGIN SELECT RAISE(ABORT, 'reviewer assignments are retained; revoke instead'); END;

CREATE TRIGGER observation_reviewer_event_state_guard
BEFORE INSERT ON observation_reviewer_events
WHEN NOT EXISTS (
  SELECT 1 FROM observation_reviewers r JOIN tenants t
    ON t.id = r.tenant_id AND t.status = 'active'
  WHERE r.tenant_id = NEW.tenant_id AND r.site_id = NEW.site_id
    AND r.reviewer_subject = NEW.reviewer_subject AND r.reviewer_role = NEW.reviewer_role
    AND ((NEW.event_type = 'assigned' AND r.status = 'active')
      OR (NEW.event_type = 'revoked' AND r.status = 'revoked'))
)
BEGIN SELECT RAISE(ABORT, 'reviewer event must match active tenant and assignment state'); END;
CREATE TRIGGER observation_reviewer_events_immutable_update_guard
BEFORE UPDATE ON observation_reviewer_events
BEGIN SELECT RAISE(ABORT, 'reviewer assignment history is immutable'); END;
CREATE TRIGGER observation_reviewer_events_immutable_delete_guard
BEFORE DELETE ON observation_reviewer_events
BEGIN SELECT RAISE(ABORT, 'reviewer assignment history cannot be deleted'); END;

CREATE TRIGGER observation_verification_active_tenant_guard
BEFORE INSERT ON observation_verification_events
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN SELECT RAISE(ABORT, 'verification event requires an active tenant'); END;
CREATE TRIGGER observation_verification_transition_guard
BEFORE INSERT ON observation_verification_events
WHEN NOT EXISTS (
  SELECT 1 FROM observation_reviewers r JOIN tenants t
    ON t.id = r.tenant_id AND t.status = 'active'
  WHERE r.tenant_id = NEW.tenant_id AND r.site_id = NEW.site_id
    AND r.reviewer_subject = NEW.reviewer_subject AND r.reviewer_role = NEW.reviewer_role
    AND r.status = 'active'
)
OR NOT EXISTS (
  SELECT 1 FROM observations o
  WHERE o.id = NEW.observation_id AND o.tenant_id = NEW.tenant_id
    AND o.site_id = NEW.site_id
    AND (
      (NEW.event_type IN ('verified', 'rejected') AND o.verification_status = 'unverified'
        AND COALESCE((SELECT e.event_type FROM observation_verification_events e
          WHERE e.tenant_id = NEW.tenant_id AND e.observation_id = NEW.observation_id
          ORDER BY e.rowid DESC LIMIT 1), 'initial') IN ('initial', 'revoked'))
      OR
      (NEW.event_type = 'revoked' AND o.verification_status = 'verified'
        AND (SELECT e.event_type FROM observation_verification_events e
          WHERE e.tenant_id = NEW.tenant_id AND e.observation_id = NEW.observation_id
          ORDER BY e.rowid DESC LIMIT 1) = 'verified')
    )
)
BEGIN SELECT RAISE(ABORT, 'invalid observation verification transition'); END;

-- A status change is accepted only when its matching append-only decision event
-- already exists in the same D1 transaction. This blocks direct status edits.
CREATE TRIGGER observations_verification_status_guard
BEFORE UPDATE OF verification_status ON observations
WHEN NEW.verification_status IS NOT OLD.verification_status
AND NOT EXISTS (
  SELECT 1 FROM observation_verification_events e
  WHERE e.observation_id = OLD.id AND e.tenant_id = OLD.tenant_id
    AND e.site_id = OLD.site_id
    AND e.event_type = CASE NEW.verification_status
      WHEN 'verified' THEN 'verified'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'unverified' THEN 'revoked'
      ELSE ''
    END
    AND ((OLD.verification_status = 'unverified' AND NEW.verification_status IN ('verified', 'rejected'))
      OR (OLD.verification_status = 'verified' AND NEW.verification_status = 'unverified'))
  ORDER BY e.rowid DESC LIMIT 1
)
BEGIN SELECT RAISE(ABORT, 'observation verification status requires a matching review event'); END;
CREATE TRIGGER observation_verification_events_immutable_update_guard
BEFORE UPDATE ON observation_verification_events
BEGIN SELECT RAISE(ABORT, 'observation verification history is immutable'); END;
CREATE TRIGGER observation_verification_events_immutable_delete_guard
BEFORE DELETE ON observation_verification_events
BEGIN SELECT RAISE(ABORT, 'observation verification history cannot be deleted'); END;
