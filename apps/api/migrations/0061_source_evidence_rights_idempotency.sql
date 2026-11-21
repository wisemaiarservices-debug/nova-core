-- Scoped exact-retry ledgers for source evidence and data-rights commands.
-- Request hashes are computed by the application from canonical payloads; D1
-- binds each immutable ledger row to the exact persisted entity/event and audit.
PRAGMA foreign_keys = ON;

CREATE TABLE source_evidence_document_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  evidence_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id,site_id,source_id,actor_subject,idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id,tenant_id,site_id,source_id)
    REFERENCES source_evidence_documents(id,tenant_id,site_id,source_id) ON DELETE RESTRICT
);
CREATE INDEX source_evidence_document_requests_scope
  ON source_evidence_document_requests(tenant_id,site_id,source_id,created_at DESC);

CREATE TABLE source_evidence_event_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('registered','verified','rejected','revoked')),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id,site_id,evidence_id,actor_subject,idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id,tenant_id,site_id,source_id)
    REFERENCES source_evidence_documents(id,tenant_id,site_id,source_id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id) REFERENCES source_evidence_events(id) ON DELETE RESTRICT
);
CREATE INDEX source_evidence_event_requests_timeline
  ON source_evidence_event_requests(tenant_id,site_id,evidence_id,created_at DESC);

CREATE TABLE source_data_rights_declaration_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  declaration_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id,site_id,source_id,actor_subject,idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (declaration_id,tenant_id,site_id,source_id)
    REFERENCES source_data_rights_declarations(id,tenant_id,site_id,source_id) ON DELETE RESTRICT
);
CREATE INDEX source_data_rights_declaration_requests_scope
  ON source_data_rights_declaration_requests(tenant_id,site_id,source_id,created_at DESC);

CREATE TABLE source_data_rights_event_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  declaration_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('declared','approved','rejected','revoked')),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id,site_id,declaration_id,actor_subject,idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (declaration_id,tenant_id,site_id,source_id)
    REFERENCES source_data_rights_declarations(id,tenant_id,site_id,source_id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id) REFERENCES source_data_rights_events(id) ON DELETE RESTRICT
);
CREATE INDEX source_data_rights_event_requests_timeline
  ON source_data_rights_event_requests(tenant_id,site_id,declaration_id,created_at DESC);

CREATE TRIGGER source_evidence_document_request_insert_guard
BEFORE INSERT ON source_evidence_document_requests
WHEN NOT EXISTS (
  SELECT 1 FROM source_evidence_documents d
  JOIN tenants t ON t.id=NEW.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  JOIN tenant_memberships m ON m.tenant_id=NEW.tenant_id
    AND m.subject=NEW.actor_subject AND m.status='active'
  JOIN audit_events a ON a.tenant_id=NEW.tenant_id
    AND a.actor_type='operator' AND a.actor_id=NEW.actor_subject
    AND a.action='source_evidence.registered'
    AND a.entity_type='source_evidence_document' AND a.entity_id=NEW.evidence_id
    AND a.request_id=NEW.request_id
  WHERE d.id=NEW.evidence_id AND d.tenant_id=NEW.tenant_id
    AND d.site_id=NEW.site_id AND d.source_id=NEW.source_id
    AND d.uploaded_by_subject=NEW.actor_subject AND d.request_id=NEW.request_id
)
BEGIN SELECT RAISE(ABORT, 'evidence creation idempotency record requires matching document and audit'); END;

CREATE TRIGGER source_evidence_event_request_insert_guard
BEFORE INSERT ON source_evidence_event_requests
WHEN NOT EXISTS (
  SELECT 1 FROM source_evidence_events e
  JOIN source_evidence_documents d ON d.id=e.evidence_id
    AND d.tenant_id=e.tenant_id AND d.site_id=e.site_id AND d.source_id=e.source_id
  JOIN tenants t ON t.id=NEW.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  JOIN tenant_memberships m ON m.tenant_id=NEW.tenant_id
    AND m.subject=NEW.actor_subject AND m.status='active'
  JOIN audit_events a ON a.tenant_id=NEW.tenant_id
    AND a.actor_type='operator' AND a.actor_id=NEW.actor_subject
    AND a.action='source_evidence.' || NEW.event_type
    AND a.entity_type='source_evidence_document' AND a.entity_id=NEW.evidence_id
    AND a.request_id=NEW.request_id
  WHERE e.id=NEW.event_id AND e.evidence_id=NEW.evidence_id
    AND e.tenant_id=NEW.tenant_id AND e.site_id=NEW.site_id
    AND e.source_id=NEW.source_id AND e.actor_subject=NEW.actor_subject
    AND e.event_type=NEW.event_type AND e.request_id=NEW.request_id
    AND d.id=NEW.evidence_id
)
BEGIN SELECT RAISE(ABORT, 'evidence event idempotency record requires matching event and audit'); END;

CREATE TRIGGER source_data_rights_declaration_request_insert_guard
BEFORE INSERT ON source_data_rights_declaration_requests
WHEN NOT EXISTS (
  SELECT 1 FROM source_data_rights_declarations d
  JOIN tenants t ON t.id=NEW.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  JOIN tenant_memberships m ON m.tenant_id=NEW.tenant_id
    AND m.subject=NEW.actor_subject AND m.status='active'
  JOIN audit_events a ON a.tenant_id=NEW.tenant_id
    AND a.actor_type='operator' AND a.actor_id=NEW.actor_subject
    AND a.action='source_data_rights.declared'
    AND a.entity_type='source_data_rights_declaration' AND a.entity_id=NEW.declaration_id
    AND a.request_id=NEW.request_id
  WHERE d.id=NEW.declaration_id AND d.tenant_id=NEW.tenant_id
    AND d.site_id=NEW.site_id AND d.source_id=NEW.source_id
    AND d.declared_by_subject=NEW.actor_subject AND d.request_id=NEW.request_id
)
BEGIN SELECT RAISE(ABORT, 'rights creation idempotency record requires matching declaration and audit'); END;

CREATE TRIGGER source_data_rights_event_request_insert_guard
BEFORE INSERT ON source_data_rights_event_requests
WHEN NOT EXISTS (
  SELECT 1 FROM source_data_rights_events e
  JOIN source_data_rights_declarations d ON d.id=e.declaration_id
    AND d.tenant_id=e.tenant_id AND d.site_id=e.site_id AND d.source_id=e.source_id
  JOIN tenants t ON t.id=NEW.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  JOIN tenant_memberships m ON m.tenant_id=NEW.tenant_id
    AND m.subject=NEW.actor_subject AND m.status='active'
  JOIN audit_events a ON a.tenant_id=NEW.tenant_id
    AND a.actor_type='operator' AND a.actor_id=NEW.actor_subject
    AND a.action='source_data_rights.' || NEW.event_type
    AND a.entity_type='source_data_rights_declaration' AND a.entity_id=NEW.declaration_id
    AND a.request_id=NEW.request_id
  WHERE e.id=NEW.event_id AND e.declaration_id=NEW.declaration_id
    AND e.tenant_id=NEW.tenant_id AND e.site_id=NEW.site_id
    AND e.source_id=NEW.source_id AND e.actor_subject=NEW.actor_subject
    AND e.event_type=NEW.event_type AND e.request_id=NEW.request_id
    AND d.id=NEW.declaration_id
)
BEGIN SELECT RAISE(ABORT, 'rights event idempotency record requires matching event and audit'); END;

-- Retry ledgers are immutable and retained for the full audit lifetime.
CREATE TRIGGER source_evidence_document_requests_no_update
BEFORE UPDATE ON source_evidence_document_requests
BEGIN SELECT RAISE(ABORT, 'evidence document requests are immutable'); END;
CREATE TRIGGER source_evidence_document_requests_no_delete
BEFORE DELETE ON source_evidence_document_requests
BEGIN SELECT RAISE(ABORT, 'evidence document requests cannot be deleted'); END;
CREATE TRIGGER source_evidence_event_requests_no_update
BEFORE UPDATE ON source_evidence_event_requests
BEGIN SELECT RAISE(ABORT, 'evidence event requests are immutable'); END;
CREATE TRIGGER source_evidence_event_requests_no_delete
BEFORE DELETE ON source_evidence_event_requests
BEGIN SELECT RAISE(ABORT, 'evidence event requests cannot be deleted'); END;
CREATE TRIGGER source_data_rights_declaration_requests_no_update
BEFORE UPDATE ON source_data_rights_declaration_requests
BEGIN SELECT RAISE(ABORT, 'rights declaration requests are immutable'); END;
CREATE TRIGGER source_data_rights_declaration_requests_no_delete
BEFORE DELETE ON source_data_rights_declaration_requests
BEGIN SELECT RAISE(ABORT, 'rights declaration requests cannot be deleted'); END;
CREATE TRIGGER source_data_rights_event_requests_no_update
BEFORE UPDATE ON source_data_rights_event_requests
BEGIN SELECT RAISE(ABORT, 'rights event requests are immutable'); END;
CREATE TRIGGER source_data_rights_event_requests_no_delete
BEFORE DELETE ON source_data_rights_event_requests
BEGIN SELECT RAISE(ABORT, 'rights event requests cannot be deleted'); END;
