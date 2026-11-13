-- NOVA water-quality criteria reviewer assignment history — 0008
-- Append-only provenance for tenant-admin controlled reviewer provisioning.
PRAGMA foreign_keys = ON;

CREATE TABLE water_quality_criteria_reviewer_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  reviewer_subject TEXT NOT NULL,
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('regulatory_reviewer', 'domain_expert')),
  jurisdiction TEXT NOT NULL CHECK (length(trim(jurisdiction)) BETWEEN 1 AND 120),
  event_type TEXT NOT NULL CHECK (event_type IN ('assigned', 'revoked')),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, reviewer_subject, reviewer_role)
    REFERENCES water_quality_criteria_reviewers(tenant_id, reviewer_subject, reviewer_role)
    ON DELETE RESTRICT
);
CREATE INDEX idx_water_quality_criteria_reviewer_events_history
  ON water_quality_criteria_reviewer_events(tenant_id, reviewer_subject, reviewer_role, occurred_at);

CREATE TRIGGER water_quality_criteria_reviewer_event_state_guard
BEFORE INSERT ON water_quality_criteria_reviewer_events
WHEN NOT EXISTS (
  SELECT 1 FROM water_quality_criteria_reviewers r
  JOIN tenants t ON t.id = r.tenant_id AND t.status = 'active'
  WHERE r.tenant_id = NEW.tenant_id
    AND r.reviewer_subject = NEW.reviewer_subject
    AND r.reviewer_role = NEW.reviewer_role
    AND r.jurisdiction = NEW.jurisdiction
    AND ((NEW.event_type = 'assigned' AND r.status = 'active')
      OR (NEW.event_type = 'revoked' AND r.status = 'revoked'))
)
BEGIN SELECT RAISE(ABORT, 'reviewer event must match active tenant and reviewer state'); END;

CREATE TRIGGER water_quality_criteria_reviewer_event_immutable_update_guard
BEFORE UPDATE ON water_quality_criteria_reviewer_events
BEGIN SELECT RAISE(ABORT, 'reviewer assignment history is immutable'); END;
CREATE TRIGGER water_quality_criteria_reviewer_event_immutable_delete_guard
BEFORE DELETE ON water_quality_criteria_reviewer_events
BEGIN SELECT RAISE(ABORT, 'reviewer assignment history cannot be deleted'); END;
