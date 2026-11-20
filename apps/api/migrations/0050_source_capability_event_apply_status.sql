-- Apply each terminal lifecycle event with a simple, explicit status transition.

CREATE TRIGGER source_capability_event_approve_status
AFTER INSERT ON source_capability_events
WHEN NEW.event_type='approved'
BEGIN
  UPDATE source_capabilities SET status='approved'
  WHERE id=NEW.capability_id AND tenant_id=NEW.tenant_id
    AND site_id=NEW.site_id AND source_id=NEW.source_id;
END;

CREATE TRIGGER source_capability_event_reject_status
AFTER INSERT ON source_capability_events
WHEN NEW.event_type='rejected'
BEGIN
  UPDATE source_capabilities SET status='rejected'
  WHERE id=NEW.capability_id AND tenant_id=NEW.tenant_id
    AND site_id=NEW.site_id AND source_id=NEW.source_id;
END;

CREATE TRIGGER source_capability_event_revoke_status
AFTER INSERT ON source_capability_events
WHEN NEW.event_type='revoked'
BEGIN
  UPDATE source_capabilities SET status='revoked'
  WHERE id=NEW.capability_id AND tenant_id=NEW.tenant_id
    AND site_id=NEW.site_id AND source_id=NEW.source_id;
END;
