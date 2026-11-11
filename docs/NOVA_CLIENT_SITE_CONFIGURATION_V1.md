# NOVA client and site configuration contract v1

This contract makes client and site specifications data-driven. It does not register records, authenticate tenants, persist data, or infer missing values.

## Supported configuration groups

- Tenant identity and configuration version.
- Site identity, tenant relationship, IANA timezone, optional WGS84 Polygon/MultiPolygon boundary, optional land area and region metadata.
- Multiple crop records with species, optional cultivar, growth stage and optional planting/harvest dates.
- Irrigation method and optional design flow/water-source description.
- Energy system fields for PV, inverter, battery capacity/power, nominal voltage, grid phase and grid connection.

All engineering quantities require explicit units or explicit field names with fixed units. Unknown information remains null or an explicit `unknown` enum; it is not filled from defaults.

## Validation and limits

- Tenant/site IDs must match within the client configuration bundle.
- Land area must be finite and positive; supported units are m², hectares, km² and acres.
- Timezone must be an IANA identifier.
- Crop harvest date cannot precede planting date.
- Energy nameplate values are positive when supplied and bounded against unreasonable input sizes.
- Boundary geometry uses the existing bounded GeoJSON structural validator. It does not prove polygon topology/self-intersection, calculate geodesic area, or verify legal ownership/boundaries.

## Not implemented

No tenant onboarding API, authorization/RLS, database migration, D1 binding, customer record, sensor integration, site registration or live telemetry is introduced. Production use requires authenticated tenant isolation, audited configuration changes, schema migration strategy and independent validation of engineering specifications.
