-- sensor_calibration_events references this three-column parent key.
-- The calibration table's four-column uniqueness does not satisfy SQLite's
-- exact parent-key requirement for (id, tenant_id, site_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_calibrations_id_tenant_site
  ON sensor_calibrations(id, tenant_id, site_id);
