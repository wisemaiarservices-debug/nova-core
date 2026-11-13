-- NOVA tenant-scoped water-quality criteria registry — 0007
-- Storage and append-only governance primitives only. No source ingestion,
-- reviewer provisioning route, legal verification or operational authorization.
PRAGMA foreign_keys = ON;

CREATE TABLE water_quality_criteria_reviewers (
  tenant_id TEXT NOT NULL,
  reviewer_subject TEXT NOT NULL CHECK (length(trim(reviewer_subject)) BETWEEN 1 AND 200),
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('regulatory_reviewer', 'domain_expert')),
  jurisdiction TEXT NOT NULL CHECK (length(trim(jurisdiction)) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  assigned_by_subject TEXT NOT NULL CHECK (length(trim(assigned_by_subject)) BETWEEN 1 AND 200),
  assignment_evidence_ref TEXT NOT NULL CHECK (length(trim(assignment_evidence_ref)) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, reviewer_subject, reviewer_role),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
CREATE INDEX idx_water_quality_criteria_reviewers_active
  ON water_quality_criteria_reviewers(tenant_id, jurisdiction, reviewer_role, status);

CREATE TABLE water_quality_criteria_entries (
  id TEXT NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT,
  jurisdiction TEXT NOT NULL CHECK (length(trim(jurisdiction)) BETWEEN 1 AND 120),
  version TEXT NOT NULL CHECK (length(trim(version)) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json) AND json_type(entry_json) = 'object'),
  source_document_sha256 TEXT NOT NULL CHECK (
    length(source_document_sha256) = 64 AND source_document_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_evidence_ref TEXT NOT NULL CHECK (length(trim(source_evidence_ref)) BETWEEN 1 AND 500),
  published_on TEXT NOT NULL CHECK (date(published_on) = published_on),
  effective_from TEXT NOT NULL CHECK (date(effective_from) = effective_from),
  effective_to TEXT CHECK (effective_to IS NULL OR date(effective_to) = effective_to),
  supersedes_entry_id TEXT,
  supersedes_entry_version TEXT,
  created_by_subject TEXT NOT NULL CHECK (length(trim(created_by_subject)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, id, version),
  UNIQUE (tenant_id, id, version, jurisdiction),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((supersedes_entry_id IS NULL AND supersedes_entry_version IS NULL) OR
         (supersedes_entry_id IS NOT NULL AND supersedes_entry_version IS NOT NULL AND supersedes_entry_id <> id)),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, supersedes_entry_id, supersedes_entry_version)
    REFERENCES water_quality_criteria_entries(tenant_id, id, version) ON DELETE RESTRICT
);
CREATE INDEX idx_water_quality_criteria_entries_scope
  ON water_quality_criteria_entries(tenant_id, site_id, jurisdiction, effective_from, effective_to);
CREATE INDEX idx_water_quality_criteria_entries_supersedes
  ON water_quality_criteria_entries(tenant_id, supersedes_entry_id);

CREATE TABLE water_quality_criteria_approvals (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  entry_version TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  reviewer_subject TEXT NOT NULL,
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('regulatory_reviewer', 'domain_expert')),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
  reviewed_at TEXT NOT NULL CHECK (length(trim(reviewed_at)) BETWEEN 20 AND 40),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
  UNIQUE (tenant_id, entry_id, entry_version, reviewer_subject, reviewer_role),
  FOREIGN KEY (tenant_id, entry_id, entry_version, jurisdiction)
    REFERENCES water_quality_criteria_entries(tenant_id, id, version, jurisdiction) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, reviewer_subject, reviewer_role)
    REFERENCES water_quality_criteria_reviewers(tenant_id, reviewer_subject, reviewer_role) ON DELETE RESTRICT
);
CREATE INDEX idx_water_quality_criteria_approvals_entry
  ON water_quality_criteria_approvals(tenant_id, entry_id, entry_version, decision);

CREATE TABLE water_quality_criteria_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  entry_version TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'draft_created', 'submitted_for_review', 'approved', 'rejected', 'superseded', 'retired'
  )),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, entry_id, entry_version)
    REFERENCES water_quality_criteria_entries(tenant_id, id, version) ON DELETE RESTRICT
);
CREATE INDEX idx_water_quality_criteria_events_history
  ON water_quality_criteria_events(tenant_id, entry_id, entry_version, occurred_at);

CREATE TRIGGER water_quality_criteria_entries_active_tenant_guard
BEFORE INSERT ON water_quality_criteria_entries
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN SELECT RAISE(ABORT, 'criteria entry requires an active tenant'); END;

CREATE TRIGGER water_quality_criteria_entry_immutable_update_guard
BEFORE UPDATE ON water_quality_criteria_entries
BEGIN SELECT RAISE(ABORT, 'criteria entry content is immutable; create a new version'); END;
CREATE TRIGGER water_quality_criteria_entry_immutable_delete_guard
BEFORE DELETE ON water_quality_criteria_entries
BEGIN SELECT RAISE(ABORT, 'criteria registry entries cannot be deleted'); END;

CREATE TRIGGER water_quality_criteria_reviewer_active_tenant_guard
BEFORE INSERT ON water_quality_criteria_reviewers
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN SELECT RAISE(ABORT, 'reviewer assignment requires an active tenant'); END;
CREATE TRIGGER water_quality_criteria_reviewer_scope_immutable_guard
BEFORE UPDATE OF tenant_id, reviewer_subject, reviewer_role, jurisdiction
ON water_quality_criteria_reviewers
WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.reviewer_subject IS NOT OLD.reviewer_subject
  OR NEW.reviewer_role IS NOT OLD.reviewer_role OR NEW.jurisdiction IS NOT OLD.jurisdiction
BEGIN SELECT RAISE(ABORT, 'reviewer identity and scope are immutable; revoke and reassign'); END;
CREATE TRIGGER water_quality_criteria_reviewer_delete_guard
BEFORE DELETE ON water_quality_criteria_reviewers
BEGIN SELECT RAISE(ABORT, 'reviewer assignments are retained; revoke instead'); END;

CREATE TRIGGER water_quality_criteria_approval_guard
BEFORE INSERT ON water_quality_criteria_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM water_quality_criteria_reviewers r
  JOIN water_quality_criteria_entries e
    ON e.tenant_id = r.tenant_id AND e.id = NEW.entry_id AND e.version = NEW.entry_version
  WHERE r.tenant_id = NEW.tenant_id
    AND r.reviewer_subject = NEW.reviewer_subject
    AND r.reviewer_role = NEW.reviewer_role
    AND r.jurisdiction = NEW.jurisdiction
    AND r.status = 'active'
    AND (SELECT ev.event_type FROM water_quality_criteria_events ev
         WHERE ev.tenant_id = e.tenant_id AND ev.entry_id = e.id AND ev.entry_version = e.version
         ORDER BY ev.rowid DESC LIMIT 1) = 'submitted_for_review'
    AND e.created_by_subject <> NEW.reviewer_subject
    AND e.tenant_id = NEW.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'criteria approval requires an active scoped reviewer distinct from author'); END;
CREATE TRIGGER water_quality_criteria_approval_immutable_update_guard
BEFORE UPDATE ON water_quality_criteria_approvals
BEGIN SELECT RAISE(ABORT, 'criteria approvals are immutable'); END;
CREATE TRIGGER water_quality_criteria_approval_immutable_delete_guard
BEFORE DELETE ON water_quality_criteria_approvals
BEGIN SELECT RAISE(ABORT, 'criteria approvals cannot be deleted'); END;

CREATE TRIGGER water_quality_criteria_events_active_tenant_guard
BEFORE INSERT ON water_quality_criteria_events
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN SELECT RAISE(ABORT, 'criteria event requires an active tenant'); END;

CREATE TRIGGER water_quality_criteria_event_transition_guard
BEFORE INSERT ON water_quality_criteria_events
WHEN
  (NEW.event_type = 'draft_created' AND EXISTS (
    SELECT 1 FROM water_quality_criteria_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.entry_id = NEW.entry_id AND e.entry_version = NEW.entry_version
  ))
  OR
  (NEW.event_type = 'submitted_for_review' AND (
    (SELECT e.event_type FROM water_quality_criteria_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.entry_id = NEW.entry_id AND e.entry_version = NEW.entry_version
     ORDER BY e.rowid DESC LIMIT 1) IS NOT 'draft_created'
  ))
  OR
  (NEW.event_type = 'approved' AND (
    (SELECT e.event_type FROM water_quality_criteria_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.entry_id = NEW.entry_id AND e.entry_version = NEW.entry_version
     ORDER BY e.rowid DESC LIMIT 1) IS NOT 'submitted_for_review'
    OR (SELECT COUNT(DISTINCT reviewer_subject) FROM water_quality_criteria_approvals a
        WHERE a.tenant_id = NEW.tenant_id AND a.entry_id = NEW.entry_id
          AND a.entry_version = NEW.entry_version AND a.decision = 'approve'
          AND a.reviewer_role = 'regulatory_reviewer') < 1
    OR (SELECT COUNT(DISTINCT reviewer_subject) FROM water_quality_criteria_approvals a
        WHERE a.tenant_id = NEW.tenant_id AND a.entry_id = NEW.entry_id
          AND a.entry_version = NEW.entry_version AND a.decision = 'approve'
          AND a.reviewer_role = 'domain_expert') < 1
    OR (SELECT COUNT(DISTINCT reviewer_subject) FROM water_quality_criteria_approvals a
        WHERE a.tenant_id = NEW.tenant_id AND a.entry_id = NEW.entry_id
          AND a.entry_version = NEW.entry_version AND a.decision = 'approve') < 2
  ))
  OR
  (NEW.event_type IN ('rejected', 'retired') AND
    (SELECT e.event_type FROM water_quality_criteria_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.entry_id = NEW.entry_id AND e.entry_version = NEW.entry_version
     ORDER BY e.rowid DESC LIMIT 1) NOT IN ('submitted_for_review', 'approved'))
  OR
  (NEW.event_type = 'superseded' AND
    (SELECT e.event_type FROM water_quality_criteria_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.entry_id = NEW.entry_id AND e.entry_version = NEW.entry_version
     ORDER BY e.rowid DESC LIMIT 1) IS NOT 'approved')
BEGIN SELECT RAISE(ABORT, 'invalid water-quality criteria lifecycle transition'); END;

CREATE TRIGGER water_quality_criteria_event_immutable_update_guard
BEFORE UPDATE ON water_quality_criteria_events
BEGIN SELECT RAISE(ABORT, 'criteria registry events are immutable'); END;
CREATE TRIGGER water_quality_criteria_event_immutable_delete_guard
BEFORE DELETE ON water_quality_criteria_events
BEGIN SELECT RAISE(ABORT, 'criteria registry events cannot be deleted'); END;
