-- Immutable, tenant/site-scoped laboratory report evidence.
-- D1 stores the bounded original bytes so the digest is calculated and
-- subsequently re-checkable against the exact persisted document.
PRAGMA foreign_keys = ON;

CREATE TABLE laboratory_report_evidence (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type = 'laboratory_report'),
  file_name TEXT NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 180),
  media_type TEXT NOT NULL CHECK (media_type = 'application/pdf'),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 1048576),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  document_bytes BLOB NOT NULL CHECK (length(document_bytes) = byte_length),
  laboratory_name TEXT NOT NULL CHECK (length(trim(laboratory_name)) BETWEEN 1 AND 200),
  report_number TEXT NOT NULL CHECK (length(trim(report_number)) BETWEEN 1 AND 120),
  sample_reference TEXT CHECK (sample_reference IS NULL OR length(trim(sample_reference)) BETWEEN 1 AND 160),
  issued_at TEXT NOT NULL CHECK (length(issued_at) BETWEEN 10 AND 40),
  verification_status TEXT NOT NULL DEFAULT 'registered_unverified'
    CHECK (verification_status = 'registered_unverified'),
  uploaded_by_subject TEXT NOT NULL CHECK (length(trim(uploaded_by_subject)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, site_id, sha256),
  UNIQUE (id, tenant_id, site_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX idx_laboratory_report_evidence_site_created
  ON laboratory_report_evidence(tenant_id, site_id, created_at DESC);

CREATE TABLE laboratory_report_evidence_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  evidence_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'registered'),
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (evidence_id, tenant_id, site_id)
    REFERENCES laboratory_report_evidence(id, tenant_id, site_id) ON DELETE RESTRICT
);
CREATE INDEX idx_laboratory_report_evidence_events_history
  ON laboratory_report_evidence_events(tenant_id, site_id, evidence_id, occurred_at);

CREATE TRIGGER laboratory_report_evidence_immutable_update_guard
BEFORE UPDATE ON laboratory_report_evidence
BEGIN SELECT RAISE(ABORT, 'laboratory report evidence is immutable'); END;
CREATE TRIGGER laboratory_report_evidence_immutable_delete_guard
BEFORE DELETE ON laboratory_report_evidence
BEGIN SELECT RAISE(ABORT, 'laboratory report evidence cannot be deleted'); END;
CREATE TRIGGER laboratory_report_evidence_events_immutable_update_guard
BEFORE UPDATE ON laboratory_report_evidence_events
BEGIN SELECT RAISE(ABORT, 'laboratory report evidence history is immutable'); END;
CREATE TRIGGER laboratory_report_evidence_events_immutable_delete_guard
BEFORE DELETE ON laboratory_report_evidence_events
BEGIN SELECT RAISE(ABORT, 'laboratory report evidence history cannot be deleted'); END;
CREATE TRIGGER laboratory_report_evidence_active_tenant_guard
BEFORE INSERT ON laboratory_report_evidence
WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active')
BEGIN SELECT RAISE(ABORT, 'laboratory evidence requires an active tenant'); END;
CREATE TRIGGER laboratory_report_evidence_event_guard
BEFORE INSERT ON laboratory_report_evidence_events
WHEN NOT EXISTS (
  SELECT 1 FROM laboratory_report_evidence e
  JOIN tenants t ON t.id = e.tenant_id AND t.status = 'active'
  WHERE e.id = NEW.evidence_id AND e.tenant_id = NEW.tenant_id
    AND e.site_id = NEW.site_id AND e.uploaded_by_subject = NEW.actor_subject
    AND e.verification_status = 'registered_unverified'
)
BEGIN SELECT RAISE(ABORT, 'laboratory evidence event must match its persisted record'); END;
