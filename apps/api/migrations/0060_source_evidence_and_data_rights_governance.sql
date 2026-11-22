-- Immutable source evidence documents and independently reviewed data-rights declarations.
-- Status is derived from append-only event history; no mutable status columns are introduced.
-- This migration intentionally does not alter capability approval or observation ingestion.

PRAGMA foreign_keys = ON;

CREATE TABLE source_evidence_documents (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 17 AND 176 AND substr(id,1,16)='source-evidence:'
  ),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'data_license','data_processing_agreement','consent_record','permit',
    'device_certificate','calibration_certificate','laboratory_report','other'
  )),
  file_name TEXT NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 180),
  media_type TEXT NOT NULL CHECK (media_type='application/pdf'),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 1048576),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  document_bytes BLOB NOT NULL CHECK (length(document_bytes)=byte_length),
  issuer_name TEXT NOT NULL CHECK (length(trim(issuer_name)) BETWEEN 1 AND 200),
  document_reference TEXT NOT NULL CHECK (length(trim(document_reference)) BETWEEN 1 AND 160),
  issued_at TEXT NOT NULL CHECK (
    (length(issued_at)=20 OR length(issued_at)=24)
    AND substr(issued_at,-1)='Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ',issued_at) IS NOT NULL
  ),
  effective_from TEXT CHECK (effective_from IS NULL OR (
    (length(effective_from)=20 OR length(effective_from)=24)
    AND substr(effective_from,-1)='Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ',effective_from) IS NOT NULL
  )),
  effective_to TEXT CHECK (effective_to IS NULL OR (
    (length(effective_to)=20 OR length(effective_to)=24)
    AND substr(effective_to,-1)='Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ',effective_to) IS NOT NULL
  )),
  uploaded_by_subject TEXT NOT NULL CHECK (length(trim(uploaded_by_subject)) BETWEEN 1 AND 200),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id,tenant_id,site_id,source_id),
  UNIQUE (id,tenant_id,site_id,source_id,sha256),
  UNIQUE (tenant_id,site_id,source_id,sha256),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR effective_from IS NULL OR julianday(effective_to)>julianday(effective_from))
);

CREATE INDEX source_evidence_documents_scope_timeline
  ON source_evidence_documents(tenant_id,site_id,source_id,created_at DESC);

CREATE TABLE source_evidence_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  evidence_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (event_type IN ('registered','verified','rejected','revoked')),
  reviewed_sha256 TEXT NOT NULL CHECK (
    length(reviewed_sha256)=64 AND reviewed_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  reason TEXT,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (evidence_id,event_type),
  FOREIGN KEY (evidence_id,tenant_id,site_id,source_id)
    REFERENCES source_evidence_documents(id,tenant_id,site_id,source_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
  CHECK (
    (event_type IN ('registered','verified') AND reason IS NULL)
    OR (event_type IN ('rejected','revoked') AND length(trim(reason)) BETWEEN 1 AND 2000)
  )
);
CREATE INDEX source_evidence_events_history
  ON source_evidence_events(tenant_id,site_id,source_id,evidence_id,occurred_at,id);

CREATE TABLE source_data_rights_declarations (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 15 AND 174 AND substr(id,1,14)='source-rights:'
  ),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  asset_id TEXT,
  supporting_evidence_id TEXT NOT NULL,
  supporting_evidence_sha256 TEXT NOT NULL CHECK (
    length(supporting_evidence_sha256)=64
    AND supporting_evidence_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  provider_name TEXT NOT NULL CHECK (length(trim(provider_name)) BETWEEN 1 AND 200),
  controller_name TEXT NOT NULL CHECK (length(trim(controller_name)) BETWEEN 1 AND 200),
  basis_type TEXT NOT NULL CHECK (basis_type IN (
    'license','contract','consent','statutory_authority','other'
  )),
  instrument_reference TEXT NOT NULL CHECK (length(trim(instrument_reference)) BETWEEN 1 AND 200),
  permitted_purposes_json TEXT NOT NULL CHECK (
    json_valid(permitted_purposes_json)
    AND json_type(permitted_purposes_json)='array'
    AND json_array_length(permitted_purposes_json) BETWEEN 1 AND 16
  ),
  restrictions_json TEXT NOT NULL CHECK (
    json_valid(restrictions_json)
    AND json_type(restrictions_json)='array'
    AND json_array_length(restrictions_json) BETWEEN 0 AND 32
  ),
  effective_from TEXT NOT NULL CHECK (
    (length(effective_from)=20 OR length(effective_from)=24)
    AND substr(effective_from,-1)='Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ',effective_from) IS NOT NULL
  ),
  effective_to TEXT CHECK (effective_to IS NULL OR (
    (length(effective_to)=20 OR length(effective_to)=24)
    AND substr(effective_to,-1)='Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ',effective_to) IS NOT NULL
  )),
  declaration_sha256 TEXT NOT NULL CHECK (
    length(declaration_sha256)=64 AND declaration_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  declared_by_subject TEXT NOT NULL CHECK (length(trim(declared_by_subject)) BETWEEN 1 AND 200),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id,tenant_id,site_id,source_id),
  UNIQUE (id,tenant_id,site_id,source_id,declaration_sha256),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
  FOREIGN KEY (supporting_evidence_id,tenant_id,site_id,source_id,supporting_evidence_sha256)
    REFERENCES source_evidence_documents(id,tenant_id,site_id,source_id,sha256) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR julianday(effective_to)>julianday(effective_from))
);
CREATE INDEX source_data_rights_scope_timeline
  ON source_data_rights_declarations(tenant_id,site_id,source_id,created_at DESC);

CREATE TABLE source_data_rights_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  declaration_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (event_type IN ('declared','approved','rejected','revoked')),
  reviewed_declaration_sha256 TEXT NOT NULL CHECK (
    length(reviewed_declaration_sha256)=64
    AND reviewed_declaration_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  reviewed_evidence_sha256 TEXT NOT NULL CHECK (
    length(reviewed_evidence_sha256)=64
    AND reviewed_evidence_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  reason TEXT,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (declaration_id,event_type),
  FOREIGN KEY (declaration_id,tenant_id,site_id,source_id)
    REFERENCES source_data_rights_declarations(id,tenant_id,site_id,source_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id,tenant_id) REFERENCES sites(id,tenant_id) ON DELETE RESTRICT,
  CHECK (
    (event_type IN ('declared','approved') AND reason IS NULL)
    OR (event_type IN ('rejected','revoked') AND length(trim(reason)) BETWEEN 1 AND 2000)
  )
);
CREATE INDEX source_data_rights_events_history
  ON source_data_rights_events(tenant_id,site_id,source_id,declaration_id,occurred_at,id);

-- A document can only be registered against the exact active, verified source scope.
CREATE TRIGGER source_evidence_document_insert_guard
BEFORE INSERT ON source_evidence_documents
WHEN NOT EXISTS (
  SELECT 1 FROM sources src
  JOIN tenants t ON t.id=src.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  JOIN tenant_memberships m ON m.tenant_id=NEW.tenant_id
    AND m.subject=NEW.uploaded_by_subject AND m.status='active'
  JOIN audit_events a ON a.tenant_id=NEW.tenant_id
    AND a.actor_type='operator' AND a.actor_id=NEW.uploaded_by_subject
    AND a.action='source_evidence.registered'
    AND a.entity_type='source_evidence_document' AND a.entity_id=NEW.id
    AND a.request_id=NEW.request_id
  WHERE src.id=NEW.source_id AND src.tenant_id=NEW.tenant_id
    AND src.site_id=NEW.site_id AND src.verification_status='verified'
)
BEGIN
  SELECT RAISE(ABORT, 'source evidence requires matching active verified source, member and audit');
END;

CREATE TRIGGER source_evidence_event_insert_guard
BEFORE INSERT ON source_evidence_events
WHEN NOT EXISTS (
  SELECT 1 FROM source_evidence_documents d
  JOIN tenants t ON t.id=NEW.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  JOIN sources src ON src.id=NEW.source_id AND src.tenant_id=NEW.tenant_id
    AND src.site_id=NEW.site_id
  JOIN audit_events a ON a.tenant_id=NEW.tenant_id
    AND a.actor_type='operator' AND a.actor_id=NEW.actor_subject
    AND a.action='source_evidence.' || NEW.event_type
    AND a.entity_type='source_evidence_document' AND a.entity_id=NEW.evidence_id
    AND a.request_id=NEW.request_id
  WHERE d.id=NEW.evidence_id AND d.tenant_id=NEW.tenant_id
    AND d.site_id=NEW.site_id AND d.source_id=NEW.source_id
    AND d.sha256=NEW.reviewed_sha256
    AND (
      (NEW.event_type='registered' AND NEW.actor_subject=d.uploaded_by_subject
        AND NOT EXISTS (SELECT 1 FROM source_evidence_events e WHERE e.evidence_id=d.id))
      OR
      (NEW.event_type IN ('verified','rejected')
        AND src.verification_status='verified'
        AND EXISTS (SELECT 1 FROM source_evidence_events e
          WHERE e.evidence_id=d.id AND e.event_type='registered'
            AND e.id=(SELECT e2.id FROM source_evidence_events e2
              WHERE e2.evidence_id=d.id ORDER BY e2.rowid DESC LIMIT 1))
        AND EXISTS (SELECT 1 FROM tenant_source_reviewers r
          JOIN tenant_memberships m ON m.tenant_id=r.tenant_id
            AND m.subject=r.reviewer_subject AND m.status='active'
          WHERE r.tenant_id=NEW.tenant_id AND r.site_id=NEW.site_id
            AND r.reviewer_subject=NEW.actor_subject AND r.status='active')
        AND NEW.actor_subject<>d.uploaded_by_subject
        AND NEW.actor_subject<>COALESCE(src.registered_by_subject,'')
      )
      OR
      (NEW.event_type='revoked'
        AND EXISTS (SELECT 1 FROM source_evidence_events e
          WHERE e.evidence_id=d.id AND e.event_type='verified'
            AND e.id=(SELECT e2.id FROM source_evidence_events e2
              WHERE e2.evidence_id=d.id ORDER BY e2.rowid DESC LIMIT 1))
        AND EXISTS (SELECT 1 FROM tenant_source_reviewers r
          JOIN tenant_memberships m ON m.tenant_id=r.tenant_id
            AND m.subject=r.reviewer_subject AND m.status='active'
          WHERE r.tenant_id=NEW.tenant_id AND r.site_id=NEW.site_id
            AND r.reviewer_subject=NEW.actor_subject AND r.status='active')
        AND NEW.actor_subject<>d.uploaded_by_subject
        AND NEW.actor_subject<>COALESCE(src.registered_by_subject,'')
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'source evidence event requires exact digest, lifecycle and independent reviewer authority');
END;

CREATE TRIGGER source_data_rights_declaration_insert_guard
BEFORE INSERT ON source_data_rights_declarations
WHEN NOT EXISTS (
  SELECT 1 FROM source_evidence_documents d
  JOIN sources src ON src.id=NEW.source_id AND src.tenant_id=NEW.tenant_id
    AND src.site_id=NEW.site_id AND src.verification_status='verified'
  JOIN tenants t ON t.id=NEW.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  JOIN tenant_memberships m ON m.tenant_id=NEW.tenant_id
    AND m.subject=NEW.declared_by_subject AND m.status='active'
  JOIN audit_events a ON a.tenant_id=NEW.tenant_id
    AND a.actor_type='operator' AND a.actor_id=NEW.declared_by_subject
    AND a.action='source_data_rights.declared'
    AND a.entity_type='source_data_rights_declaration' AND a.entity_id=NEW.id
    AND a.request_id=NEW.request_id
  WHERE d.id=NEW.supporting_evidence_id AND d.tenant_id=NEW.tenant_id
    AND d.site_id=NEW.site_id AND d.source_id=NEW.source_id
    AND d.sha256=NEW.supporting_evidence_sha256
    AND EXISTS (SELECT 1 FROM source_evidence_events e
      WHERE e.evidence_id=d.id AND e.event_type='verified'
        AND e.id=(SELECT e2.id FROM source_evidence_events e2
          WHERE e2.evidence_id=d.id ORDER BY e2.rowid DESC LIMIT 1))
    AND (NEW.asset_id IS NULL OR EXISTS (SELECT 1 FROM assets a2
      WHERE a2.id=NEW.asset_id AND a2.tenant_id=NEW.tenant_id
        AND a2.site_id=NEW.site_id AND a2.status='active'))
)
OR EXISTS (
  SELECT 1 FROM json_each(NEW.permitted_purposes_json) p
  WHERE p.type<>'text' OR p.value NOT IN (
    'measurement_ingestion','storage','quality_assessment','analytics',
    'model_training','sharing','publication'
  )
)
OR EXISTS (
  SELECT 1 FROM json_each(NEW.permitted_purposes_json) p
  GROUP BY p.value HAVING COUNT(*)>1
)
OR EXISTS (
  SELECT 1 FROM json_each(NEW.restrictions_json) r
  WHERE r.type<>'text' OR length(trim(r.value)) NOT BETWEEN 1 AND 500
)
BEGIN
  SELECT RAISE(ABORT, 'data rights declaration requires verified scoped evidence, active authority and explicit valid purposes');
END;

CREATE TRIGGER source_data_rights_event_insert_guard
BEFORE INSERT ON source_data_rights_events
WHEN NOT EXISTS (
  SELECT 1 FROM source_data_rights_declarations d
  JOIN source_evidence_documents doc ON doc.id=d.supporting_evidence_id
    AND doc.tenant_id=d.tenant_id AND doc.site_id=d.site_id
    AND doc.source_id=d.source_id AND doc.sha256=d.supporting_evidence_sha256
  JOIN sources src ON src.id=d.source_id AND src.tenant_id=d.tenant_id
    AND src.site_id=d.site_id
  JOIN tenants t ON t.id=NEW.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  JOIN audit_events a ON a.tenant_id=NEW.tenant_id
    AND a.actor_type='operator' AND a.actor_id=NEW.actor_subject
    AND a.action='source_data_rights.' || NEW.event_type
    AND a.entity_type='source_data_rights_declaration' AND a.entity_id=NEW.declaration_id
    AND a.request_id=NEW.request_id
  WHERE d.id=NEW.declaration_id AND d.tenant_id=NEW.tenant_id
    AND d.site_id=NEW.site_id AND d.source_id=NEW.source_id
    AND d.declaration_sha256=NEW.reviewed_declaration_sha256
    AND doc.sha256=NEW.reviewed_evidence_sha256
    AND EXISTS (SELECT 1 FROM source_evidence_events ee
      WHERE ee.evidence_id=doc.id AND ee.event_type='verified'
        AND ee.id=(SELECT ee2.id FROM source_evidence_events ee2
          WHERE ee2.evidence_id=doc.id ORDER BY ee2.rowid DESC LIMIT 1))
    AND (
      (NEW.event_type='declared' AND NEW.actor_subject=d.declared_by_subject
        AND NOT EXISTS (SELECT 1 FROM source_data_rights_events e
          WHERE e.declaration_id=d.id))
      OR
      (NEW.event_type IN ('approved','rejected')
        AND NEW.actor_subject<>d.declared_by_subject
        AND NEW.actor_subject<>doc.uploaded_by_subject
        AND NEW.actor_subject<>COALESCE(src.registered_by_subject,'')
        AND EXISTS (SELECT 1 FROM tenant_source_reviewers r
          JOIN tenant_memberships m ON m.tenant_id=r.tenant_id
            AND m.subject=r.reviewer_subject AND m.status='active'
          WHERE r.tenant_id=NEW.tenant_id AND r.site_id=NEW.site_id
            AND r.reviewer_subject=NEW.actor_subject AND r.status='active')
        AND EXISTS (SELECT 1 FROM source_data_rights_events e
          WHERE e.declaration_id=d.id AND e.event_type='declared'
            AND e.id=(SELECT e2.id FROM source_data_rights_events e2
              WHERE e2.declaration_id=d.id ORDER BY e2.rowid DESC LIMIT 1))
        AND (NEW.event_type<>'approved' OR (
          julianday(d.effective_from)<=julianday('now')
          AND (d.effective_to IS NULL OR julianday(d.effective_to)>julianday('now'))
        ))
      )
      OR
      (NEW.event_type='revoked'
        AND NEW.actor_subject<>d.declared_by_subject
        AND NEW.actor_subject<>doc.uploaded_by_subject
        AND NEW.actor_subject<>COALESCE(src.registered_by_subject,'')
        AND EXISTS (SELECT 1 FROM tenant_source_reviewers r
          JOIN tenant_memberships m ON m.tenant_id=r.tenant_id
            AND m.subject=r.reviewer_subject AND m.status='active'
          WHERE r.tenant_id=NEW.tenant_id AND r.site_id=NEW.site_id
            AND r.reviewer_subject=NEW.actor_subject AND r.status='active')
        AND EXISTS (SELECT 1 FROM source_data_rights_events e
          WHERE e.declaration_id=d.id AND e.event_type='approved'
            AND e.id=(SELECT e2.id FROM source_data_rights_events e2
              WHERE e2.declaration_id=d.id ORDER BY e2.rowid DESC LIMIT 1))
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'data rights event requires exact declaration and evidence digests, valid lifecycle and independent reviewer authority');
END;

-- All source evidence and rights records/events are append-only.
CREATE TRIGGER source_evidence_documents_immutable_update
BEFORE UPDATE ON source_evidence_documents
BEGIN SELECT RAISE(ABORT, 'source evidence documents are immutable'); END;
CREATE TRIGGER source_evidence_documents_immutable_delete
BEFORE DELETE ON source_evidence_documents
BEGIN SELECT RAISE(ABORT, 'source evidence documents cannot be deleted'); END;
CREATE TRIGGER source_evidence_events_immutable_update
BEFORE UPDATE ON source_evidence_events
BEGIN SELECT RAISE(ABORT, 'source evidence events are immutable'); END;
CREATE TRIGGER source_evidence_events_immutable_delete
BEFORE DELETE ON source_evidence_events
BEGIN SELECT RAISE(ABORT, 'source evidence events cannot be deleted'); END;
CREATE TRIGGER source_data_rights_declarations_immutable_update
BEFORE UPDATE ON source_data_rights_declarations
BEGIN SELECT RAISE(ABORT, 'source data rights declarations are immutable'); END;
CREATE TRIGGER source_data_rights_declarations_immutable_delete
BEFORE DELETE ON source_data_rights_declarations
BEGIN SELECT RAISE(ABORT, 'source data rights declarations cannot be deleted'); END;
CREATE TRIGGER source_data_rights_events_immutable_update
BEFORE UPDATE ON source_data_rights_events
BEGIN SELECT RAISE(ABORT, 'source data rights events are immutable'); END;
CREATE TRIGGER source_data_rights_events_immutable_delete
BEFORE DELETE ON source_data_rights_events
BEGIN SELECT RAISE(ABORT, 'source data rights events cannot be deleted'); END;
