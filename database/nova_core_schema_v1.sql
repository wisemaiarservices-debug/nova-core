-- NOVA Core Schema v1
-- Shared foundation for NOVA OS modules.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    organization_type TEXT,
    country TEXT,
    timezone TEXT DEFAULT 'UTC',
    subscription_plan TEXT DEFAULT 'pilot',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    site_type TEXT,
    country TEXT,
    region TEXT,
    timezone TEXT DEFAULT 'UTC',
    latitude NUMERIC,
    longitude NUMERIC,
    boundary GEOMETRY(POLYGON, 4326),
    status TEXT DEFAULT 'active',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL,
    asset_name TEXT NOT NULL,
    asset_code TEXT,
    status TEXT DEFAULT 'active',
    location GEOMETRY(POINT, 4326),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asset_relationships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    site_id UUID REFERENCES sites(id) ON DELETE CASCADE,
    source_asset_id UUID REFERENCES assets(id) ON DELETE CASCADE,
    target_asset_id UUID REFERENCES assets(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    strength NUMERIC DEFAULT 1.0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS digital_twins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    site_id UUID REFERENCES sites(id) ON DELETE CASCADE,
    twin_type TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    twin_state JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forecasts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    site_id UUID REFERENCES sites(id) ON DELETE CASCADE,
    forecast_type TEXT NOT NULL,
    horizon TEXT,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    predicted_value NUMERIC,
    unit TEXT,
    confidence NUMERIC,
    model_name TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_recommendations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    site_id UUID REFERENCES sites(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    confidence NUMERIC,
    expected_impact JSONB DEFAULT '{}',
    status TEXT DEFAULT 'open',
    generated_by TEXT DEFAULT 'NOVA',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
