-- Restore the exact composite parent key referenced by tenant-scoped
-- calibration, sensor-source mapping and measurement-quality foreign keys.
-- Asset IDs are globally unique already; this index makes the declared
-- tenant/site relationship an explicit SQLite parent key for those FKs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_id_tenant_site
  ON assets(id, tenant_id, site_id);
