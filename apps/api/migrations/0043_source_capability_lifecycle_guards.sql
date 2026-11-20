-- Commit-time guards for the governed source capability lifecycle.
-- Kept separate from table creation to make ordered D1 validation diagnostic.

CREATE TRIGGER source_capability_insert_guard
BEFORE INSERT ON source_capabilities
WHEN NEW.status <> 'pending'
  OR NOT EXISTS (
    SELECT 1 FROM sources src
    JOIN tenants t ON t.id=src.tenant_id AND t.status='active'
    JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
    WHERE src.id=NEW.source_id AND src.tenant_id=NEW.tenant_id
      AND src.site_id=NEW.site_id AND src.module=NEW.module
      AND src.verification_status='verified'
  )
  OR NOT EXISTS (
    SELECT 1 FROM tenant_memberships m
    WHERE m.tenant_id=NEW.tenant_id AND m.subject=NEW.created_by_subject
      AND m.status='active'
  )
  OR (NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM assets a WHERE a.id=NEW.asset_id
      AND a.tenant_id=NEW.tenant_id AND a.site_id=NEW.site_id AND a.status='active'
  ))
  OR EXISTS (
    SELECT 1 FROM source_capabilities prior
    WHERE prior.tenant_id=NEW.tenant_id AND prior.site_id=NEW.site_id
      AND prior.source_id=NEW.source_id
      AND COALESCE(prior.asset_id,'')=COALESCE(NEW.asset_id,'')
      AND prior.module=NEW.module AND prior.metric=NEW.metric
      AND prior.unit=NEW.unit AND prior.version>=NEW.version
  )
BEGIN
  SELECT RAISE(ABORT, 'source capability requires verified source, active scope and a new pending version');
END;

CREATE TRIGGER source_capability_identity_immutable
BEFORE UPDATE OF id, tenant_id, site_id, source_id, asset_id, module, metric, unit,
  measurement_kind, quantity_semantics, acquisition_protocol, protocol_version,
  sampling_mode, interval_seconds, max_age_seconds, max_future_skew_seconds,
  timezone, allowed_quality_flags_json, calibration_required, calibration_profile_ref,
  data_rights_ref, evidence_ref, version, created_by_subject, created_at
ON source_capabilities
BEGIN
  SELECT RAISE(ABORT, 'source capability definition is immutable; create a new version');
END;

CREATE TRIGGER source_capability_status_guard
BEFORE UPDATE OF status ON source_capabilities
WHEN NOT (
  (OLD.status='pending' AND NEW.status='approved'
    AND EXISTS (SELECT 1 FROM source_capability_events e
      WHERE e.capability_id=OLD.id AND e.event_type='approved'))
  OR (OLD.status='pending' AND NEW.status='rejected'
    AND EXISTS (SELECT 1 FROM source_capability_events e
      WHERE e.capability_id=OLD.id AND e.event_type='rejected'))
  OR (OLD.status='approved' AND NEW.status='revoked'
    AND EXISTS (SELECT 1 FROM source_capability_events e
      WHERE e.capability_id=OLD.id AND e.event_type='revoked'))
)
BEGIN
  SELECT RAISE(ABORT, 'source capability status transition requires its matching review event');
END;

CREATE TRIGGER source_capability_no_delete
BEFORE DELETE ON source_capabilities
BEGIN
  SELECT RAISE(ABORT, 'source capabilities are retained');
END;

CREATE TRIGGER source_capability_event_scope_guard
BEFORE INSERT ON source_capability_events
WHEN NOT EXISTS (
  SELECT 1
  FROM source_capabilities c
  JOIN sources src ON src.id=c.source_id AND src.tenant_id=c.tenant_id
    AND src.site_id=c.site_id AND src.module=c.module
  JOIN tenants t ON t.id=c.tenant_id AND t.status='active'
  JOIN sites s ON s.id=c.site_id AND s.tenant_id=c.tenant_id AND s.status='active'
  WHERE c.id=NEW.capability_id AND c.tenant_id=NEW.tenant_id
    AND c.site_id=NEW.site_id AND c.source_id=NEW.source_id
    AND (NEW.event_type='revoked' OR src.verification_status='verified')
)
BEGIN
  SELECT RAISE(ABORT, 'source capability event scope or source verification is invalid');
END;

CREATE TRIGGER source_capability_submission_guard
BEFORE INSERT ON source_capability_events
WHEN NEW.event_type='submitted' AND NOT EXISTS (
  SELECT 1
  FROM source_capabilities c
  JOIN tenant_memberships m ON m.tenant_id=c.tenant_id
    AND m.subject=c.created_by_subject AND m.status='active'
  WHERE c.id=NEW.capability_id AND c.status='pending'
    AND c.created_by_subject=NEW.actor_subject
)
BEGIN
  SELECT RAISE(ABORT, 'capability submission requires its active creator');
END;

CREATE TRIGGER source_capability_review_guard
BEFORE INSERT ON source_capability_events
WHEN NEW.event_type IN ('approved','rejected','revoked') AND NOT EXISTS (
  SELECT 1
  FROM source_capabilities c
  JOIN tenant_source_reviewers r ON r.tenant_id=c.tenant_id
    AND r.site_id=c.site_id AND r.reviewer_subject=NEW.actor_subject
    AND r.status='active'
  JOIN tenant_memberships m ON m.tenant_id=r.tenant_id
    AND m.subject=r.reviewer_subject AND m.status='active'
  WHERE c.id=NEW.capability_id
    AND c.created_by_subject<>NEW.actor_subject
    AND (
      (NEW.event_type IN ('approved','rejected') AND c.status='pending'
        AND EXISTS (SELECT 1 FROM source_capability_events submitted
          WHERE submitted.capability_id=c.id AND submitted.event_type='submitted'))
      OR (NEW.event_type='revoked' AND c.status='approved')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'capability review requires an independent active reviewer and valid lifecycle');
END;

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

CREATE TRIGGER source_capability_events_immutable_update
BEFORE UPDATE ON source_capability_events
BEGIN
  SELECT RAISE(ABORT, 'source capability events are immutable');
END;
CREATE TRIGGER source_capability_events_immutable_delete
BEFORE DELETE ON source_capability_events
BEGIN
  SELECT RAISE(ABORT, 'source capability events cannot be deleted');
END;
