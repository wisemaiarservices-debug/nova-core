-- Capability lifecycle guard: identity_immutable.

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
