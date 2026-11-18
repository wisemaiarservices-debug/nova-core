-- Make terminal assessment audit events inseparable from operation terminalization.
-- The AFTER trigger executes in the same SQLite statement/transaction as the
-- state update; a rejected event aborts and rolls back the terminal transition.

ALTER TABLE measurement_assessment_operations ADD COLUMN terminal_request_id TEXT;

CREATE UNIQUE INDEX idx_measurement_assessment_operations_terminal_request
 ON measurement_assessment_operations(operation_id, terminal_request_id)
 WHERE terminal_request_id IS NOT NULL;

CREATE TRIGGER measurement_assessment_operations_terminal_guard
BEFORE UPDATE ON measurement_assessment_operations
WHEN (NEW.state IN ('completed','not_assessed')
      AND (NEW.terminal_request_id IS NULL OR length(trim(NEW.terminal_request_id))=0))
 OR (NEW.state NOT IN ('completed','not_assessed') AND NEW.terminal_request_id IS NOT NULL)
 OR (OLD.state IN ('completed','not_assessed') AND NEW.terminal_request_id IS NOT OLD.terminal_request_id)
 OR (NEW.state='completed' AND OLD.state<>'running')
 OR (NEW.state='not_assessed' AND OLD.state NOT IN ('reserved','running'))
 OR (NEW.state='completed' AND NOT EXISTS (
      SELECT 1 FROM measurement_quality_assessments assessment
      WHERE assessment.id=NEW.assessment_id AND assessment.tenant_id=NEW.tenant_id
        AND assessment.site_id=NEW.site_id AND assessment.observation_id=NEW.observation_id
        AND assessment.request_id=NEW.operation_id AND assessment.status IN ('passed','failed')
    ))
 OR (NEW.state='not_assessed' AND NOT EXISTS (
      SELECT 1 FROM measurement_quality_assessments assessment
      WHERE assessment.id=NEW.assessment_id AND assessment.tenant_id=NEW.tenant_id
        AND assessment.site_id=NEW.site_id AND assessment.observation_id=NEW.observation_id
        AND assessment.request_id=NEW.operation_id AND assessment.status='not_assessed'
    ))
BEGIN
 SELECT RAISE(ABORT,'assessment operation terminalization requires exact linked assessment and request id');
END;

CREATE TRIGGER measurement_assessment_operations_terminal_event
AFTER UPDATE OF state ON measurement_assessment_operations
WHEN OLD.state IN ('reserved','running') AND NEW.state IN ('completed','not_assessed')
BEGIN
 INSERT INTO measurement_assessment_operation_events
  (event_id,operation_id,tenant_id,site_id,observation_id,actor_subject,
   from_state,to_state,event_type,request_id)
 VALUES (
  lower(hex(randomblob(16))),NEW.operation_id,NEW.tenant_id,NEW.site_id,
  NEW.observation_id,NEW.actor_subject,OLD.state,NEW.state,
  CASE NEW.state WHEN 'completed' THEN 'completed' ELSE 'not_assessed' END,
  NEW.terminal_request_id
 );
END;
