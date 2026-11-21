-- Observation capability commit-time enforcement — 0055
-- Historical observations remain unchanged and are not backfilled or grandfathered.
-- Every new observation INSERT must carry explicit metadata and match one currently
-- approved capability. Calibration-required capabilities resolve the live evidence
-- chain again at the D1 write boundary.
PRAGMA foreign_keys = ON;

ALTER TABLE observations ADD COLUMN source_capability_id TEXT
  REFERENCES source_capabilities(id) ON DELETE RESTRICT;
ALTER TABLE observations ADD COLUMN measurement_kind TEXT
  CHECK (measurement_kind IS NULL OR measurement_kind IN ('measured','derived'));
ALTER TABLE observations ADD COLUMN acquisition_protocol TEXT
  CHECK (acquisition_protocol IS NULL OR length(trim(acquisition_protocol)) BETWEEN 1 AND 80);
ALTER TABLE observations ADD COLUMN protocol_version TEXT
  CHECK (protocol_version IS NULL OR length(trim(protocol_version)) BETWEEN 1 AND 80);
ALTER TABLE observations ADD COLUMN sampling_mode TEXT
  CHECK (sampling_mode IS NULL OR sampling_mode IN ('interval','event'));
ALTER TABLE observations ADD COLUMN sampling_interval_seconds INTEGER
  CHECK (sampling_interval_seconds IS NULL OR sampling_interval_seconds BETWEEN 1 AND 31536000);

CREATE INDEX observations_capability_scope_lookup
  ON observations(tenant_id,site_id,source_id,source_capability_id,observed_at);

CREATE TRIGGER observations_capability_insert_guard
BEFORE INSERT ON observations
WHEN NEW.source_capability_id IS NULL
  OR NEW.measurement_kind IS NULL
  OR NEW.acquisition_protocol IS NULL
  OR NEW.protocol_version IS NULL
  OR NEW.sampling_mode IS NULL
  OR (NEW.sampling_mode='interval' AND NEW.sampling_interval_seconds IS NULL)
  OR (NEW.sampling_mode='event' AND NEW.sampling_interval_seconds IS NOT NULL)
  OR (
    SELECT COUNT(*)
    FROM source_capabilities c
    JOIN tenants t ON t.id=c.tenant_id AND t.status='active'
    JOIN sites s ON s.id=c.site_id AND s.tenant_id=c.tenant_id AND s.status='active'
    JOIN sources src ON src.id=c.source_id AND src.tenant_id=c.tenant_id
      AND src.module=c.module AND src.verification_status='verified'
    WHERE c.status='approved'
      AND c.tenant_id=NEW.tenant_id
      AND c.site_id=NEW.site_id
      AND c.source_id=NEW.source_id
      AND c.module=NEW.module
      AND c.metric=NEW.metric
      AND c.unit=NEW.unit
      AND COALESCE(c.asset_id,'')=COALESCE(NEW.asset_id,'')
      AND c.measurement_kind=NEW.measurement_kind
      AND c.acquisition_protocol=NEW.acquisition_protocol
      AND c.protocol_version=NEW.protocol_version
      AND c.sampling_mode=NEW.sampling_mode
      AND ((c.sampling_mode='interval' AND c.interval_seconds=NEW.sampling_interval_seconds)
        OR (c.sampling_mode='event' AND NEW.sampling_interval_seconds IS NULL))
      AND EXISTS (
        SELECT 1 FROM source_capability_events ce
        WHERE ce.capability_id=c.id AND ce.event_type='approved'
          AND ce.id=(SELECT latest.id FROM source_capability_events latest
            WHERE latest.capability_id=c.id
            ORDER BY julianday(latest.occurred_at) DESC,latest.rowid DESC LIMIT 1)
      )
      AND julianday(NEW.observed_at) IS NOT NULL
      AND julianday(NEW.observed_at) >= julianday('now') - (c.max_age_seconds / 86400.0)
      AND julianday(NEW.observed_at) <= julianday('now') + (c.max_future_skew_seconds / 86400.0)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.quality_flags_json) submitted
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(c.allowed_quality_flags_json) allowed
          WHERE allowed.value=submitted.value
        )
      )
      AND (c.calibration_required=0 OR EXISTS (
        SELECT 1
        FROM source_calibration_profiles p
        JOIN sensor_source_identity_mappings m
          ON m.id=p.mapping_id AND m.tenant_id=p.tenant_id
          AND m.site_id=p.site_id AND m.asset_id=p.asset_id
          AND m.source_id=p.source_id
        JOIN sensor_calibrations cal
          ON cal.tenant_id=p.tenant_id AND cal.site_id=p.site_id
          AND cal.asset_id=p.asset_id AND cal.sensor_id=m.sensor_id
          AND cal.parameter=p.parameter AND cal.unit=p.unit
        WHERE p.profile_ref=c.calibration_profile_ref
          AND p.tenant_id=c.tenant_id AND p.site_id=c.site_id
          AND p.asset_id=c.asset_id AND p.source_id=c.source_id
          AND p.parameter=c.metric AND p.unit=c.unit
          AND julianday(m.effective_from) IS NOT NULL
          AND julianday(m.effective_from) <= julianday(NEW.observed_at)
          AND (m.effective_to IS NULL OR julianday(m.effective_to) > julianday(NEW.observed_at))
          AND EXISTS (
            SELECT 1 FROM sensor_source_mapping_events me
            WHERE me.mapping_id=m.id AND me.tenant_id=m.tenant_id
              AND me.event_type='verified'
              AND me.id=(SELECT latest.id FROM sensor_source_mapping_events latest
                WHERE latest.tenant_id=m.tenant_id AND latest.mapping_id=m.id
                ORDER BY julianday(latest.occurred_at) DESC,latest.rowid DESC LIMIT 1)
          )
          AND julianday(cal.calibrated_at) IS NOT NULL
          AND julianday(cal.valid_until) IS NOT NULL
          AND julianday(cal.calibrated_at) <= julianday(NEW.observed_at)
          AND julianday(cal.valid_until) > julianday(NEW.observed_at)
          AND EXISTS (
            SELECT 1 FROM sensor_calibration_verification_events cve
            WHERE cve.calibration_id=cal.id AND cve.tenant_id=cal.tenant_id
              AND cve.event_type='verified'
              AND cve.id=(SELECT latest.id FROM sensor_calibration_verification_events latest
                WHERE latest.tenant_id=cal.tenant_id AND latest.calibration_id=cal.id
                ORDER BY julianday(latest.occurred_at) DESC,latest.rowid DESC LIMIT 1)
          )
      ))
  ) <> 1
BEGIN
  SELECT RAISE(ABORT, 'observation requires exactly one current approved capability and valid calibration evidence');
END;

CREATE TRIGGER observations_capability_metadata_immutable
BEFORE UPDATE OF source_capability_id,measurement_kind,acquisition_protocol,
  protocol_version,sampling_mode,sampling_interval_seconds ON observations
WHEN NEW.source_capability_id IS NOT OLD.source_capability_id
  OR NEW.measurement_kind IS NOT OLD.measurement_kind
  OR NEW.acquisition_protocol IS NOT OLD.acquisition_protocol
  OR NEW.protocol_version IS NOT OLD.protocol_version
  OR NEW.sampling_mode IS NOT OLD.sampling_mode
  OR NEW.sampling_interval_seconds IS NOT OLD.sampling_interval_seconds
BEGIN
  SELECT RAISE(ABORT, 'observation capability metadata is immutable');
END;
