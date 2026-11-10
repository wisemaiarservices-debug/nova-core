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
