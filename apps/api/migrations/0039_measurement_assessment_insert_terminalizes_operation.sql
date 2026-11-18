-- Bind a quality-assessment insert to the exact active operation lease.
-- The AFTER INSERT trigger terminalizes the operation; migration 0038 then
-- appends the terminal event. All three effects occur in the same SQLite
-- statement, so any trigger error rolls the assessment insert back as well.

ALTER TABLE measurement_quality_assessments ADD COLUMN operation_actor_subject TEXT;
ALTER TABLE measurement_quality_assessments ADD COLUMN operation_lease_version INTEGER;
ALTER TABLE measurement_quality_assessments ADD COLUMN operation_lease_request_id TEXT;
ALTER TABLE measurement_quality_assessments ADD COLUMN operation_terminal_request_id TEXT;
ALTER TABLE measurement_quality_assessments ADD COLUMN operation_completed_at TEXT;

CREATE TRIGGER measurement_quality_assessment_operation_binding_guard
BEFORE INSERT ON measurement_quality_assessments
WHEN
  (NEW.operation_actor_subject IS NULL AND (
    NEW.operation_lease_version IS NOT NULL OR
    NEW.operation_lease_request_id IS NOT NULL OR
    NEW.operation_terminal_request_id IS NOT NULL OR
    NEW.operation_completed_at IS NOT NULL
  ))
  OR
  (NEW.operation_actor_subject IS NOT NULL AND (
    NEW.operation_lease_version IS NULL OR NEW.operation_lease_version<1 OR
    NEW.operation_lease_request_id IS NULL OR length(trim(NEW.operation_lease_request_id))=0 OR
    NEW.operation_terminal_request_id IS NULL OR length(trim(NEW.operation_terminal_request_id))=0 OR
    NEW.operation_completed_at IS NULL OR
    NEW.status NOT IN ('passed','failed','not_assessed') OR
    NOT EXISTS (
      SELECT 1
      FROM measurement_assessment_operations operation
      JOIN tenants tenant ON tenant.id=operation.tenant_id AND tenant.status='active'
      JOIN sites site ON site.id=operation.site_id AND site.tenant_id=operation.tenant_id AND site.status='active'
      JOIN tenant_memberships membership ON membership.tenant_id=operation.tenant_id
        AND membership.subject=operation.actor_subject AND membership.status='active'
      JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=operation.tenant_id
        AND grant_read.subject=operation.actor_subject AND grant_read.resource_type='site'
        AND grant_read.resource_id=operation.site_id AND grant_read.action='read'
      WHERE operation.operation_id=NEW.request_id
        AND operation.tenant_id=NEW.tenant_id AND operation.site_id=NEW.site_id
        AND operation.observation_id=NEW.observation_id
        AND operation.actor_subject=NEW.operation_actor_subject
        AND operation.state='running'
        AND operation.lease_version=NEW.operation_lease_version
        AND operation.lease_request_id=NEW.operation_lease_request_id
        AND operation.lease_expires_at>NEW.operation_completed_at
    )
  ))
  OR
  (NEW.operation_actor_subject IS NULL AND EXISTS (
    SELECT 1 FROM measurement_assessment_operations operation
    WHERE operation.operation_id=NEW.request_id AND operation.tenant_id=NEW.tenant_id
  ))
BEGIN
 SELECT RAISE(ABORT,'assessment operation binding requires the exact active actor, scope and lease');
END;

CREATE TRIGGER measurement_quality_assessment_operation_terminalize
AFTER INSERT ON measurement_quality_assessments
WHEN NEW.operation_actor_subject IS NOT NULL
BEGIN
 UPDATE measurement_assessment_operations
 SET state=CASE WHEN NEW.status IN ('passed','failed') THEN 'completed' ELSE 'not_assessed' END,
     assessment_id=NEW.id,
     completed_at=NEW.operation_completed_at,
     lease_expires_at=NULL,
     lease_request_id=NULL,
     terminal_request_id=NEW.operation_terminal_request_id,
     updated_at=NEW.operation_completed_at
 WHERE operation_id=NEW.request_id
   AND tenant_id=NEW.tenant_id
   AND site_id=NEW.site_id
   AND observation_id=NEW.observation_id
   AND actor_subject=NEW.operation_actor_subject
   AND state='running'
   AND lease_version=NEW.operation_lease_version
   AND lease_request_id=NEW.operation_lease_request_id;
END;
