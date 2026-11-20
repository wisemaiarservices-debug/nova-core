-- Capability lifecycle guard: event_apply_status.

CREATE TRIGGER source_capability_event_apply_status
AFTER INSERT ON source_capability_events
WHEN NEW.event_type IN ('approved','rejected','revoked')
BEGIN
  UPDATE source_capabilities
  SET status=CASE NEW.event_type
    WHEN 'approved' THEN 'approved'
    WHEN 'rejected' THEN 'rejected'
    ELSE 'revoked'
  END
  WHERE id=NEW.capability_id AND tenant_id=NEW.tenant_id
    AND site_id=NEW.site_id AND source_id=NEW.source_id;
END;
