-- Bind calibration-required capabilities to an exact immutable profile.
-- This is a registration-time guard; observation-time calibration validity is
-- enforced by a later migration at the observation INSERT boundary.
PRAGMA foreign_keys = ON;

CREATE TRIGGER source_capability_calibration_profile_insert_guard
BEFORE INSERT ON source_capabilities
WHEN NEW.calibration_required=1 AND NOT EXISTS (
  SELECT 1 FROM source_calibration_profiles p
  WHERE p.profile_ref=NEW.calibration_profile_ref
    AND p.tenant_id=NEW.tenant_id
    AND p.site_id=NEW.site_id
    AND p.asset_id=NEW.asset_id
    AND p.source_id=NEW.source_id
    AND p.parameter=NEW.metric
    AND p.unit=NEW.unit
)
BEGIN
  SELECT RAISE(ABORT, 'calibration-required capability must reference an exact tenant/site/asset/source/metric/unit profile');
END;

CREATE TRIGGER source_capability_calibration_profile_update_guard
BEFORE UPDATE OF calibration_required,calibration_profile_ref,tenant_id,site_id,asset_id,source_id,metric,unit
ON source_capabilities
WHEN NEW.calibration_required=1 AND NOT EXISTS (
  SELECT 1 FROM source_calibration_profiles p
  WHERE p.profile_ref=NEW.calibration_profile_ref
    AND p.tenant_id=NEW.tenant_id
    AND p.site_id=NEW.site_id
    AND p.asset_id=NEW.asset_id
    AND p.source_id=NEW.source_id
    AND p.parameter=NEW.metric
    AND p.unit=NEW.unit
)
BEGIN
  SELECT RAISE(ABORT, 'calibration-required capability must reference an exact tenant/site/asset/source/metric/unit profile');
END;
