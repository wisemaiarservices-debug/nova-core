-- Governed tenant/site source registry lifecycle — 0028
-- A registered source starts unverified. Only an independently assigned reviewer
-- may verify, reject or revoke it. Ingestion continues to require verified status.

PRAGMA foreign_keys = ON;

ALTER TABLE sources ADD COLUMN registered_by_subject TEXT;

CREATE TABLE tenant_source_reviewers (
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  reviewer_subject TEXT NOT NULL CHECK (length(trim(reviewer_subject)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  assigned_by_subject TEXT NOT NULL CHECK (length(trim(assigned_by_subject)) BETWEEN 1 AND 200),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, site_id, reviewer_subject),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE tenant_source_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (event_type IN ('registered', 'verified', 'rejected', 'revoked')),
  evidence_ref TEXT,
  reason TEXT,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) BETWEEN 1 AND 160),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, source_id, event_type, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT,
  CHECK (
    (event_type = 'registered' AND length(trim(evidence_ref)) BETWEEN 1 AND 500 AND reason IS NULL)
    OR (event_type = 'verified' AND length(trim(evidence_ref)) BETWEEN 1 AND 500 AND reason IS NULL)
    OR (event_type IN ('rejected', 'revoked') AND length(trim(evidence_ref)) BETWEEN 1 AND 500 AND length(trim(reason)) BETWEEN 1 AND 2000)
  )
);
CREATE INDEX idx_tenant_source_events_timeline
  ON tenant_source_events(tenant_id, source_id, occurred_at DESC, id);


CREATE TABLE tenant_source_registration_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  source_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, site_id, actor_subject, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (site_id, tenant_id) REFERENCES sites(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT
);
CREATE TRIGGER tenant_source_registration_request_immutable_update
BEFORE UPDATE ON tenant_source_registration_requests
BEGIN SELECT RAISE(ABORT, 'source registration requests are immutable'); END;
CREATE TRIGGER tenant_source_registration_request_immutable_delete
BEFORE DELETE ON tenant_source_registration_requests
BEGIN SELECT RAISE(ABORT, 'source registration requests cannot be deleted'); END;

CREATE TRIGGER tenant_source_reviewer_assignment_guard
BEFORE INSERT ON tenant_source_reviewers
WHEN NOT EXISTS (
  SELECT 1 FROM tenants t JOIN sites s ON s.tenant_id=t.id
  WHERE t.id=NEW.tenant_id AND t.status='active' AND s.id=NEW.site_id
) OR NOT EXISTS (
  SELECT 1 FROM tenant_memberships m
  WHERE m.tenant_id=NEW.tenant_id AND m.subject=NEW.reviewer_subject AND m.status='active'
) OR NEW.reviewer_subject=NEW.assigned_by_subject OR NOT EXISTS (
  SELECT 1 FROM tenant_memberships a
  WHERE a.tenant_id=NEW.tenant_id AND a.subject=NEW.assigned_by_subject
    AND a.status='active' AND a.role IN ('tenant_owner','tenant_admin')
)
BEGIN SELECT RAISE(ABORT, 'source reviewer assignment requires active tenant admin and member'); END;

CREATE TRIGGER tenant_source_reviewer_update_guard
BEFORE UPDATE ON tenant_source_reviewers
WHEN NEW.tenant_id<>OLD.tenant_id OR NEW.site_id<>OLD.site_id
  OR NEW.reviewer_subject<>OLD.reviewer_subject OR NEW.assigned_by_subject<>OLD.assigned_by_subject
  OR NEW.evidence_ref<>OLD.evidence_ref OR OLD.status<>'active' OR NEW.status<>'revoked'
BEGIN SELECT RAISE(ABORT, 'source reviewer assignment may only be revoked'); END;
CREATE TRIGGER tenant_source_reviewers_no_delete
BEFORE DELETE ON tenant_source_reviewers
BEGIN SELECT RAISE(ABORT, 'source reviewer assignments are retained'); END;


CREATE TABLE tenant_source_reviewer_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  reviewer_subject TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('assigned','revoked')),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  reason TEXT,
  request_id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (tenant_id,site_id,reviewer_subject)
    REFERENCES tenant_source_reviewers(tenant_id,site_id,reviewer_subject) ON DELETE RESTRICT,
  CHECK ((event_type='assigned' AND reason IS NULL) OR
         (event_type='revoked' AND length(trim(reason)) BETWEEN 1 AND 2000))
);
CREATE TRIGGER tenant_source_reviewer_event_guard
BEFORE INSERT ON tenant_source_reviewer_events
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id AND t.status='active'
  WHERE m.tenant_id=NEW.tenant_id AND m.subject=NEW.actor_subject
    AND m.status='active' AND m.role IN ('tenant_owner','tenant_admin')
) OR (NEW.event_type='assigned' AND NOT EXISTS (
  SELECT 1 FROM tenant_source_reviewers r WHERE r.tenant_id=NEW.tenant_id
    AND r.site_id=NEW.site_id AND r.reviewer_subject=NEW.reviewer_subject
    AND r.status='active' AND r.assigned_by_subject=NEW.actor_subject
)) OR (NEW.event_type='revoked' AND NOT EXISTS (
  SELECT 1 FROM tenant_source_reviewers r WHERE r.tenant_id=NEW.tenant_id
    AND r.site_id=NEW.site_id AND r.reviewer_subject=NEW.reviewer_subject
    AND r.status='revoked'
))
BEGIN SELECT RAISE(ABORT, 'source reviewer event requires current tenant admin authority'); END;
CREATE TRIGGER tenant_source_reviewer_events_immutable_update
BEFORE UPDATE ON tenant_source_reviewer_events
BEGIN SELECT RAISE(ABORT, 'source reviewer events are immutable'); END;
CREATE TRIGGER tenant_source_reviewer_events_immutable_delete
BEFORE DELETE ON tenant_source_reviewer_events
BEGIN SELECT RAISE(ABORT, 'source reviewer events cannot be deleted'); END;

CREATE TRIGGER tenant_source_event_guard
BEFORE INSERT ON tenant_source_events
WHEN NOT EXISTS (
  SELECT 1 FROM sources src JOIN tenants t ON t.id=src.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  WHERE src.id=NEW.source_id AND src.tenant_id=NEW.tenant_id AND src.site_id=NEW.site_id
) OR (
  NEW.event_type='registered' AND NOT EXISTS (
    SELECT 1 FROM tenant_memberships m WHERE m.tenant_id=NEW.tenant_id
      AND m.subject=NEW.actor_subject AND m.status='active'
      AND m.role IN ('tenant_owner','tenant_admin')
  )
) OR (
  NEW.event_type IN ('verified','rejected','revoked') AND NOT EXISTS (
    SELECT 1 FROM tenant_source_reviewers r
    JOIN tenant_memberships m ON m.tenant_id=r.tenant_id
      AND m.subject=r.reviewer_subject AND m.status='active'
    WHERE r.tenant_id=NEW.tenant_id AND r.site_id=NEW.site_id
      AND r.reviewer_subject=NEW.actor_subject AND r.status='active'
      AND NEW.actor_subject<>(SELECT registered_by_subject FROM sources WHERE id=NEW.source_id)
  )
) OR (
  (NEW.event_type IN ('verified','rejected') AND EXISTS (
    SELECT 1 FROM tenant_source_events e WHERE e.tenant_id=NEW.tenant_id
      AND e.source_id=NEW.source_id AND e.event_type IN ('verified','rejected','revoked')
  ))
  OR (NEW.event_type='revoked' AND NOT EXISTS (
    SELECT 1 FROM tenant_source_events e WHERE e.tenant_id=NEW.tenant_id
      AND e.source_id=NEW.source_id AND e.event_type='verified'
      AND e.id=(SELECT e2.id FROM tenant_source_events e2
        WHERE e2.tenant_id=NEW.tenant_id AND e2.source_id=NEW.source_id
        ORDER BY e2.occurred_at DESC,e2.rowid DESC LIMIT 1)
  ))
)
BEGIN SELECT RAISE(ABORT, 'source lifecycle event violates scope, authority or transition'); END;

CREATE TRIGGER tenant_source_event_apply_status
AFTER INSERT ON tenant_source_events
WHEN NEW.event_type IN ('verified','rejected','revoked')
BEGIN
  UPDATE sources SET verification_status=CASE NEW.event_type
    WHEN 'verified' THEN 'verified' WHEN 'rejected' THEN 'unverified'
    ELSE 'disabled' END,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id AND site_id=NEW.site_id;
END;

CREATE TRIGGER tenant_source_events_immutable_update
BEFORE UPDATE ON tenant_source_events
BEGIN SELECT RAISE(ABORT, 'source lifecycle events are immutable'); END;
CREATE TRIGGER tenant_source_events_immutable_delete
BEFORE DELETE ON tenant_source_events
BEGIN SELECT RAISE(ABORT, 'source lifecycle events cannot be deleted'); END;

CREATE TRIGGER tenant_source_identity_immutable
BEFORE UPDATE OF id, tenant_id, site_id, module, provider, source_type, display_name,
  endpoint_reference, verification_method, license_reference, metadata_json, created_at
ON sources
WHEN EXISTS (SELECT 1 FROM tenant_source_events e WHERE e.source_id=OLD.id AND e.tenant_id=OLD.tenant_id)
BEGIN SELECT RAISE(ABORT, 'registered source identity is immutable'); END;
