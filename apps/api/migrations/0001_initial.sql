-- NOVA Core D1 schema foundation — 0001
-- Apply with Cloudflare D1 migrations only after a D1 database is provisioned.
-- No production database binding or write endpoint is enabled by this migration.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  description TEXT,
  latitude REAL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  timezone TEXT,
  status TEXT NOT NULL DEFAULT 'unconfigured'
    CHECK (status IN ('unconfigured', 'active', 'inactive', 'archived')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((latitude IS NULL AND longitude IS NULL) OR
         (latitude IS NOT NULL AND longitude IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  asset_type TEXT NOT NULL,
  external_ref TEXT,
  status TEXT NOT NULL DEFAULT 'unconfigured'
    CHECK (status IN ('unconfigured', 'active', 'inactive', 'retired')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (id, site_id),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_assets_site_status
  ON assets(site_id, status);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  module TEXT NOT NULL CHECK (module IN ('nova-core', 'neoagro', 'neogrid', 'neocell')),
  provider TEXT NOT NULL,
  source_type TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  endpoint_reference TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'verified', 'disabled')),
  verification_method TEXT,
  license_reference TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_sources_site_module
  ON sources(site_id, module, verification_status);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  asset_id TEXT,
  source_id TEXT NOT NULL,
  module TEXT NOT NULL CHECK (module IN ('nova-core', 'neoagro', 'neogrid', 'neocell')),
  metric TEXT NOT NULL CHECK (length(trim(metric)) BETWEEN 1 AND 120),
  value REAL,
  unit TEXT NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 48),
  observed_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'verified', 'rejected')),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  quality_flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(quality_flags_json)),
  retention_until TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, site_id) REFERENCES assets(id, site_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_idempotency
  ON observations(source_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_observations_site_metric_time
  ON observations(site_id, metric, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_source_time
  ON observations(source_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_retention
  ON observations(retention_until) WHERE retention_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'operator', 'service')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  request_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json))
);

CREATE INDEX IF NOT EXISTS idx_audit_entity_time
  ON audit_events(entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_request
  ON audit_events(request_id) WHERE request_id IS NOT NULL;
