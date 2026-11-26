# NOVA Core Architecture

## High-Level Flow

```text
User
↓
NOVA Command Center
↓
API Gateway
↓
NOVA Core Services
↓
Digital Twin + Knowledge Graph
↓
Forecast Engine
↓
Recommendation Engine
↓
Optimization Engine
↓
PostgreSQL + PostGIS + TimescaleDB + Redis
↓
IoT + SCADA + Weather + Satellite + GIS + External APIs
```

## Shared Domain Model

- Organization
- Site
- Asset
- Sensor
- Telemetry
- Digital Twin
- Knowledge Graph Relationship
- Forecast
- Recommendation
- Recommendation Result
- Optimization Run
- Alert
- Report
- Audit Log

## Product Compatibility

NOVA Core must remain compatible with:

- NeoAgro field, crop, water, weather, satellite, and agrivoltaic modules
- NeoGrid solar, battery, grid, carbon, and energy optimization modules
- NeoCell deployment, gateway, sensor, infrastructure, and Digital Twin sync modules

## Implementation Rule

Build shared services incrementally. Do not force existing products to rewrite their full schemas immediately.
