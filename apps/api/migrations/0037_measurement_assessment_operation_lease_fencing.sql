-- Fence each active assessment lease to the exact transport request that won
-- the conditional operation update. This prevents a losing concurrent claimant
-- from appending a second event after another claimant has advanced the lease.
ALTER TABLE measurement_assessment_operations ADD COLUMN lease_request_id TEXT;

CREATE UNIQUE INDEX idx_measurement_assessment_operations_lease_request
 ON measurement_assessment_operations(operation_id, lease_request_id)
 WHERE lease_request_id IS NOT NULL;

CREATE TRIGGER measurement_assessment_operations_lease_fence_guard
BEFORE UPDATE ON measurement_assessment_operations
WHEN (NEW.state='running' AND (NEW.lease_request_id IS NULL OR NEW.lease_expires_at IS NULL))
 OR (NEW.state<>'running' AND NEW.lease_request_id IS NOT NULL)
 OR NEW.lease_version<OLD.lease_version
 OR NEW.lease_version>OLD.lease_version+1
 OR (NEW.lease_version=OLD.lease_version
     AND NEW.lease_request_id IS NOT OLD.lease_request_id
     AND NOT (OLD.state='running' AND NEW.state IN ('completed','not_assessed','failed')
              AND NEW.lease_request_id IS NULL))
 OR (NEW.lease_version=OLD.lease_version
     AND NEW.lease_expires_at IS NOT OLD.lease_expires_at
     AND NOT (OLD.state='running' AND NEW.state IN ('completed','not_assessed','failed')
              AND NEW.lease_expires_at IS NULL))
 OR (NEW.lease_version=OLD.lease_version+1
     AND (NEW.state<>'running' OR NEW.lease_request_id IS NULL
          OR NEW.lease_request_id IS OLD.lease_request_id))
BEGIN
 SELECT RAISE(ABORT,'assessment operation lease fencing is invalid');
END;

CREATE TRIGGER measurement_assessment_operations_no_direct_running_insert
BEFORE INSERT ON measurement_assessment_operations
WHEN NEW.state='running' OR NEW.lease_request_id IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'assessment operation must be reserved before it is claimed');
END;

CREATE TRIGGER measurement_assessment_operation_lease_event_guard
BEFORE INSERT ON measurement_assessment_operation_events
WHEN NEW.event_type IN ('claimed','lease_renewed','lease_recovered')
 AND NOT EXISTS (
   SELECT 1 FROM measurement_assessment_operations operation
   WHERE operation.operation_id=NEW.operation_id
     AND operation.tenant_id=NEW.tenant_id
     AND operation.actor_subject=NEW.actor_subject
     AND operation.state='running'
     AND operation.lease_request_id=NEW.request_id
 )
BEGIN
 SELECT RAISE(ABORT,'assessment operation lease event does not match the current fence');
END;
