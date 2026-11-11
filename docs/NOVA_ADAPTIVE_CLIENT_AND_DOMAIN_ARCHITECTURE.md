# NOVA adaptive client architecture and research experiment pipeline

## Product requirement: one shared adaptive Core

NOVA Core is the shared intelligence, evidence and orchestration layer for NOVA OS and every NeoHaven domain platform. Domain applications are clients of the Core; they must not fork their own competing intelligence or assume a single deployment profile.

The system must support new customers and sites with different and changing specifications, including:

- Land and site geometry, area, boundaries, elevation and local climate.
- Crop species, cultivars, growth stages, planting calendars, soil and irrigation methods.
- Water sources, pumps, flow meters, valves and irrigation network characteristics.
- Solar PV, inverter, battery, storage, grid and load specifications, including capacity, voltage, phase, power and operating constraints.
- Sensors, gateways and controllers from different vendors, units, precision, ranges, calibration, sampling rates, timestamps, communication protocols and firmware versions.
- Infrastructure assets, dimensions, materials, operating envelopes and maintenance constraints.

A new profile must be represented through versioned, validated configuration and capability descriptors. It must not require a bespoke code path for every customer.

## Configuration and capability model

Future implementation should separate:

1. **Tenant and site profile** — tenant, site, geometry, area, timezone, locale, permissions and configuration version. Customer identity and access boundaries are mandatory.
2. **Domain profile** — crops and phenology, irrigation topology, energy system, asset classes and engineering constraints.
3. **Equipment and sensor capability registry** — manufacturer/model identifiers where known, measurement definitions, units, ranges, precision, calibration, cadence, protocol and firmware. Unknown fields remain explicitly unknown.
4. **Canonical observation contract** — stable metric identifiers, canonical units, event time, received time, source identity, device identity, quality flags, calibration and provenance.
5. **Scientific knowledge and dataset registry** — source/version, licence, spatial and temporal coverage, evidence class, units, latency, known limitations and citation.
6. **Model and method registry** — domain, task, required features, supported units, applicability envelope, training dataset snapshots, code/model versions, calibration and evaluation results.
7. **Decision and safety policy** — recommendations remain bounded by engineering constraints, evidence quality, uncertainty and human approval.

## Adaptation workflow

1. Discover client/site/equipment specifications from operator input or supported integrations.
2. Validate schemas, ranges, units, geometry, compatibility and required fields. Never infer an unknown device specification or customer site boundary.
3. Normalize measurements into canonical metric and unit contracts while preserving original values and source metadata.
4. Check whether a scientific method/model is applicable to the profile, climate, crop, equipment and data coverage.
5. If compatible, execute in a sandboxed/offline or approved research context; otherwise return an explicit state such as not supported, insufficient data or needs configuration.
6. Compare outputs against explicit baselines and independent holdout observations. Keep field observations distinct from provider, satellite, reanalysis, model and synthetic evidence.
7. Record immutable dataset snapshots, configuration versions, feature definitions, model/code versions, evaluation windows and metrics.
8. Promote a model only after documented scientific review, safety review and human approval. New clients must not silently retrain or change a deployed model.

## Learning and model governance

- Shared learning is permitted only when data rights, consent, privacy and tenant isolation allow it.
- Customer-specific calibration must be separable from global model parameters.
- Training, validation and test partitions must be chronological and geographically/client separated where appropriate to test generalization.
- Prevent leakage across sites, crops, devices, seasons and overlapping satellite/reanalysis windows.
- Report MAE/RMSE/bias and task-appropriate metrics, compare against simple baselines, and evaluate calibration and subgroup performance.
- A model trained on one crop, region, sensor family or inverter topology must not be assumed to generalize to another without evidence.
- Track drift, missingness, sensor calibration, firmware changes and distribution shifts; request revalidation when applicability conditions change.
- Synthetic fixtures are for software tests only and never count as field validation.
- No autonomous critical infrastructure control. Operational recommendations require guardrails, permissions, audit trails and human approval.

## Current implementation boundary

The current research experiment pipeline is an offline foundation. It joins a caller-supplied research AOI, validated WaPOR raster-processing manifest, immutable dataset snapshot and experiment manifest; it can compute regression metrics from caller-supplied arrays against an explicit baseline.

It does not yet provide tenant/site onboarding, equipment discovery, sensor protocol adapters, canonical unit conversion, dataset persistence, training, automated model selection, model deployment, live telemetry, scientific validation or cross-client generalization. No pilot/customer site is assumed. Research AOIs must be supplied explicitly and retain a null site_id.

## Next implementation gates

- Versioned tenant/site/domain configuration schemas and migrations.
- Sensor/equipment capability registry with unit ontology and protocol adapter conformance tests.
- Crop, irrigation, PV, battery and infrastructure specification libraries with source-backed limits.
- Canonical measurement/unit conversion service with dimensional checks and calibration provenance.
- Dataset snapshot storage and experiment registry persistence behind approved storage controls.
- Training/evaluation jobs with leakage-resistant geographic and temporal validation.
- Model applicability and abstention service, drift monitoring and human-review workflow.
- NOVA OS evidence UI showing profile completeness, source coverage, applicability, validation and limitations.
