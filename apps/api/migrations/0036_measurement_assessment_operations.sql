PRAGMA foreign_keys = ON;

-- Durable, actor-scoped operation identity for reload-safe assessment recovery.
-- This migration is additive: existing assessment routes remain unchanged until
-- a later runtime migration routes every new assessment through this ledger.

-- SQLite requires an exact unique parent key for the composite assessment FK.
CREATE UNIQUE INDEX idx_measurement_quality_assessments_operation_scope
 ON measurement_quality_assessments(id, tenant_id, site_id, observation_id, request_id);

CREATE TABLE measurement_assessment_operations (
 operation_id TEXT PRIMARY KEY CHECK(length(trim(operation_id)) BETWEEN 1 AND 160),
 tenant_id TEXT NOT NULL,
 site_id TEXT NOT NULL,
 observation_id TEXT NOT NULL,
 actor_subject TEXT NOT NULL CHECK(length(trim(actor_subject)) BETWEEN 1 AND 200),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^a-f0-9]*'),
 state TEXT NOT NULL CHECK(state IN ('reserved','running','completed','not_assessed','failed')),
 assessment_id TEXT,
 predecessor_operation_id TEXT,
 lease_version INTEGER NOT NULL DEFAULT 0 CHECK(lease_version >= 0),
 lease_expires_at TEXT,
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 completed_at TEXT,
 UNIQUE(operation_id, tenant_id, site_id, observation_id),
 UNIQUE(assessment_id),
 FOREIGN KEY(observation_id, tenant_id, site_id)
  REFERENCES observations(id, tenant_id, site_id) ON DELETE RESTRICT,
 FOREIGN KEY(assessment_id, tenant_id, site_id, observation_id, operation_id)
  REFERENCES measurement_quality_assessments(id, tenant_id, site_id, observation_id, request_id) ON DELETE RESTRICT,
 FOREIGN KEY(predecessor_operation_id, tenant_id, site_id, observation_id)
  REFERENCES measurement_assessment_operations(operation_id, tenant_id, site_id, observation_id) ON DELETE RESTRICT,
 CHECK(
   (state IN ('completed','not_assessed') AND assessment_id IS NOT NULL AND completed_at IS NOT NULL)
   OR (state IN ('reserved','running','failed') AND assessment_id IS NULL AND completed_at IS NULL)
 )
);

-- At most one unresolved operation for a given actor and observation.
-- Different actors remain isolated and may independently initiate work.
CREATE UNIQUE INDEX idx_measurement_assessment_operations_one_active
 ON measurement_assessment_operations(tenant_id, actor_subject, observation_id)
 WHERE state IN ('reserved','running');

CREATE INDEX idx_measurement_assessment_operations_actor_history
 ON measurement_assessment_operations(tenant_id, actor_subject, observation_id, created_at DESC);

CREATE INDEX idx_measurement_assessment_operations_lease
 ON measurement_assessment_operations(state, lease_expires_at)
 WHERE state='running';

-- A completed operation may have at most one explicit successor. NULL
-- predecessors are intentionally excluded from this uniqueness constraint.
CREATE UNIQUE INDEX idx_measurement_assessment_operations_one_successor
 ON measurement_assessment_operations(tenant_id, predecessor_operation_id)
 WHERE predecessor_operation_id IS NOT NULL;

CREATE TABLE measurement_assessment_operation_events (
 event_id TEXT PRIMARY KEY,
 operation_id TEXT NOT NULL,
 tenant_id TEXT NOT NULL,
 site_id TEXT NOT NULL,
 observation_id TEXT NOT NULL,
 actor_subject TEXT NOT NULL,
 from_state TEXT CHECK(from_state IS NULL OR from_state IN ('reserved','running','completed','not_assessed','failed')),
 to_state TEXT NOT NULL CHECK(to_state IN ('reserved','running','completed','not_assessed','failed')),
 event_type TEXT NOT NULL CHECK(event_type IN ('reserved','claimed','lease_renewed','completed','not_assessed','failed','lease_recovered')),
 request_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(operation_id, tenant_id, site_id, observation_id)
  REFERENCES measurement_assessment_operations(operation_id, tenant_id, site_id, observation_id) ON DELETE RESTRICT
);

CREATE INDEX idx_measurement_assessment_operation_events_history
 ON measurement_assessment_operation_events(tenant_id, operation_id, occurred_at, event_id);

CREATE TRIGGER measurement_assessment_operations_scope_immutable
BEFORE UPDATE ON measurement_assessment_operations
WHEN NEW.operation_id<>OLD.operation_id
 OR NEW.tenant_id<>OLD.tenant_id
 OR NEW.site_id<>OLD.site_id
 OR NEW.observation_id<>OLD.observation_id
 OR NEW.actor_subject<>OLD.actor_subject
 OR NEW.request_digest<>OLD.request_digest
 OR NEW.predecessor_operation_id IS NOT OLD.predecessor_operation_id
BEGIN
 SELECT RAISE(ABORT,'assessment operation identity and scope are immutable');
END;

CREATE TRIGGER measurement_assessment_operations_transition_guard
BEFORE UPDATE ON measurement_assessment_operations
WHEN NOT (
  (OLD.state='reserved' AND NEW.state IN ('reserved','running','not_assessed','failed'))
  OR (OLD.state='running' AND NEW.state IN ('running','completed','not_assessed','failed'))
)
 OR NEW.lease_version<OLD.lease_version
 OR NEW.attempt_count<OLD.attempt_count
 OR (OLD.assessment_id IS NOT NULL AND NEW.assessment_id IS NOT OLD.assessment_id)
 OR (OLD.state IN ('completed','not_assessed','failed') AND (
      NEW.state<>OLD.state
      OR NEW.lease_version<>OLD.lease_version
      OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
      OR NEW.attempt_count<>OLD.attempt_count
      OR NEW.assessment_id IS NOT OLD.assessment_id
      OR NEW.completed_at IS NOT OLD.completed_at
    ))
BEGIN
 SELECT RAISE(ABORT,'assessment operation transition is invalid');
END;

CREATE TRIGGER measurement_assessment_operations_successor_guard
BEFORE INSERT ON measurement_assessment_operations
WHEN NEW.predecessor_operation_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM measurement_assessment_operations predecessor
   WHERE predecessor.operation_id=NEW.predecessor_operation_id
     AND predecessor.tenant_id=NEW.tenant_id
     AND predecessor.site_id=NEW.site_id
     AND predecessor.observation_id=NEW.observation_id
     AND predecessor.actor_subject=NEW.actor_subject
     AND predecessor.state IN ('completed','not_assessed')
 )
BEGIN
 SELECT RAISE(ABORT,'assessment successor requires a completed operation by the same actor and scope');
END;

CREATE TRIGGER measurement_assessment_operation_event_guard
BEFORE INSERT ON measurement_assessment_operation_events
WHEN NOT EXISTS (
 SELECT 1 FROM measurement_assessment_operations operation
 WHERE operation.operation_id=NEW.operation_id
   AND operation.tenant_id=NEW.tenant_id
   AND operation.site_id=NEW.site_id
   AND operation.observation_id=NEW.observation_id
   AND operation.actor_subject=NEW.actor_subject
   AND operation.state=NEW.to_state
)
 OR (NEW.from_state IS NULL AND EXISTS (
   SELECT 1 FROM measurement_assessment_operation_events prior
   WHERE prior.operation_id=NEW.operation_id
 ))
 OR (NEW.from_state IS NOT NULL AND (
   SELECT prior.to_state FROM measurement_assessment_operation_events prior
   WHERE prior.operation_id=NEW.operation_id
   ORDER BY prior.occurred_at DESC, prior.rowid DESC LIMIT 1
 ) IS NOT NEW.from_state)
BEGIN
 SELECT RAISE(ABORT,'assessment operation event does not match its guarded state');
END;

CREATE TRIGGER measurement_assessment_operations_no_delete
BEFORE DELETE ON measurement_assessment_operations
BEGIN
 SELECT RAISE(ABORT,'assessment operation history cannot be deleted');
END;

CREATE TRIGGER measurement_assessment_operation_events_immutable_update
BEFORE UPDATE ON measurement_assessment_operation_events
BEGIN
 SELECT RAISE(ABORT,'assessment operation events are immutable');
END;

CREATE TRIGGER measurement_assessment_operation_events_immutable_delete
BEFORE DELETE ON measurement_assessment_operation_events
BEGIN
 SELECT RAISE(ABORT,'assessment operation events cannot be deleted');
END;
