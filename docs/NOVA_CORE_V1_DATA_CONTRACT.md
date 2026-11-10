# NOVA Core V1 — Data Integrity and Screening Contract

## Status

This change establishes a more honest V1 contract for the existing API. It does not connect external datasets, calibrate agronomic models, or establish production readiness.

## Input provenance

Every analytical response reports:

- data_mode: synthetic_defaults, mixed_synthetic_and_caller_supplied, or caller_supplied_unverified
- provided_fields: fields explicitly included in the request
- defaulted_fields: fields populated by synthetic model defaults
- caller_supplied_values_verified: always false until a trusted ingestion and validation process exists

A caller-supplied value is not automatically a sensor observation. A future ingestion adapter must attach source, timestamp, location, units, quality flags, and validation status before data can be described as verified telemetry.

## Screening methodology

The current screening rules use two transparent flags:

- Temperature at or above 37 °C: high-heat screening flag
- Reported soil moisture below 35%: low-moisture screening flag

These are provisional software thresholds for triage only. They are not universal agronomic thresholds and must not be used as crop-specific irrigation setpoints. Crop, cultivar, growth stage, soil texture, root depth, sensor calibration, local weather, rainfall, and evapotranspiration are not currently represented.

The API deliberately returns null for numeric water-demand and solar-production deltas. The previous fixed percentages were not supported by a validated model or connected data source.

## Impact accounting

Water savings, energy shifted, carbon reduction, yield-risk reduction, and resilience gain are returned as null with an explanatory status. The existing request fields do not establish a counterfactual baseline or measured intervention outcome.

A future impact model must specify baseline period and measured baseline values; intervention definition and comparison period; instrumentation and data quality; calculation formula and units; emission-factor source and reporting year for carbon; uncertainty range and missing-data treatment.

## Recommendation safety

Recommendations are screening prompts for human review. The API does not issue irrigation commands or operate equipment. The operator must verify field conditions and local agronomic guidance.

## V1 data roadmap

1. Add source adapters with provenance and quality metadata.
2. Add weather observations and forecasts from documented public providers.
3. Add crop, soil, and location context before agronomic interpretation.
4. Implement reference evapotranspiration using a documented FAO-56 Penman–Monteith method only when all required meteorological inputs and units are available.
5. Validate model outputs against independent observations and report error metrics before describing forecasts as validated.
6. Add measured baseline/intervention accounting before reporting savings or carbon impact.

## Compatibility note

Existing endpoint paths and core response keys are retained where meaningful. Numeric impact claims and fabricated optimized scenario values are intentionally removed. Consumers must handle null values and inspect the status, methodology, and input_provenance fields.

## First external data adapter: NASA POWER

The V1 API includes a daily point-data retrieval endpoint at /api/v1/data/weather/nasa-power/daily. It requests daily temperature, relative humidity, precipitation, wind speed, and all-sky surface shortwave radiation from the NASA POWER Daily API.

NASA POWER documents daily meteorological and solar time series from 1981 to near real time, supports UTC time standard, and provides JSON responses. The adapter preserves units and source metadata when supplied, converts the provider fill value to null, and identifies the result as gridded/model-derived rather than a local station measurement.

Endpoint query parameters: latitude, longitude, start_date, and end_date. The adapter limits requests to 367 calendar days and uses a 20-second network timeout. Provider failures return HTTP 502; invalid date ranges return HTTP 422.

NASA POWER states that there are no restrictions on use, access, or download of its data and requests citation of the NASA POWER Project. Attribution is included in the API response. Users must still inspect dataset-specific terms for any additional third-party datasets introduced later.

Source documentation: https://power.larc.nasa.gov/docs/services/api/temporal/daily/


## Browser integration and CORS

The API exposes a configurable exact-origin allowlist through `NOVA_CORE_ALLOWED_ORIGINS`, a comma-separated server-side environment variable. Local development defaults include the NeoAgro, NOVA OS, NeoGrid and NeoCell development ports. Production deployments must replace or extend this value with the exact HTTPS origins of the deployed clients.

Credentials are disabled in CORS. Only the required GET, POST and OPTIONS methods and Accept / Content-Type headers are allowed. Do not use wildcard origins with credentialed requests. The health endpoint confirms API reachability only; it does not certify telemetry availability or data quality.


Example production allowlist (use only the domains that actually need browser access):

```bash
NOVA_CORE_ALLOWED_ORIGINS=https://nova-os-pied.vercel.app,https://neoagro-six.vercel.app,https://neocell-ebon.vercel.app,https://neogrid-sigma.vercel.app
```

Preview deployments use changing hostnames and should be added explicitly only when required for testing; do not use a wildcard origin.
