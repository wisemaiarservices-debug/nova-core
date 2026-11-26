# NOVA client and site configuration contract v1

This contract makes client and site specifications data-driven. It validates supplied configuration only; it does not register records, authenticate tenants, persist data, or infer missing values.

## Supported configuration groups

- Tenant identity, data region and configuration version.
- Site identity, tenant relationship, IANA timezone, optional WGS84 Polygon/MultiPolygon boundary, optional land area and region metadata.
- Multiple crop records with species, optional cultivar, growth stage and optional planting/harvest dates.
- Irrigation method and optional design flow in m³/hour and water-source description.
- Energy system fields for PV, inverter, battery capacity/power, nominal voltage, grid phase and grid connection.
- Bounded key/value site metadata entries.

All engineering quantities use explicit units or fixed-unit field names. Unknown information remains null or an explicit \`unknown\` enum; it is not filled from defaults.

## Validation and limits

- Tenant/site IDs and configuration versions must match within the client configuration bundle.
- Land area must be finite, positive and no more than 100 million km² after conversion; supported units are m², hectares, km² and acres.
- Timezone must be an IANA identifier.
- Crop IDs and metadata keys are unique; each site is limited to 200 crop records and 100 metadata entries.
- Site metadata, crop collections and GeoJSON coordinate collections are immutable tuples.
- Crop harvest date cannot precede planting date.
- Energy nameplate values are positive when supplied and bounded against unreasonable input sizes.
- Boundary geometry uses the existing bounded GeoJSON structural validator. It does not prove polygon topology/self-intersection, calculate geodesic area, or verify legal ownership/boundaries.

## Not implemented

No tenant onboarding API, authorization/RLS, database migration, D1 binding, customer record, sensor integration, site registration or live telemetry is introduced. Production use requires authenticated tenant isolation, audited configuration changes, schema migration strategy and independent validation of engineering specifications.
