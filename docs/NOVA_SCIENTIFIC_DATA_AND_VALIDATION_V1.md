# NOVA scientific data and validation foundation (V1)

**Status:** design and engineering gate; no new provider has been connected by this document.  
**Operating rule:** use real, attributable public data for reproducible research, but never describe gridded, reanalysis, satellite-derived, or modelled products as local field measurements.

## 1. V1 objective

Build a demonstrable, evidence-led intelligence platform across NeoAgro, NeoGrid and NeoCell. V1 should demonstrate that NOVA can:

1. discover and retrieve documented public datasets;
2. preserve source identity, license/terms, units, spatial and temporal resolution, processing lineage and uncertainty;
3. normalize data into a shared observation contract without losing its original meaning;
4. compute transparent scientific indicators and deterministic baselines;
5. train and evaluate bounded models on suitable historical data;
6. compare predictions with held-out observations and publish measured performance;
7. expose evidence, limitations and human-review requirements in NOVA OS.

V1 is not a claim that one model knows everything. It is a set of domain-specific, versioned capabilities with a shared provenance, evaluation and audit framework.

## 2. Evidence classes — mandatory vocabulary

Every displayed value, chart, recommendation and model feature must carry one of these classes:

- `field_observation`: measurement from a named instrument/operator with a traceable site/asset, timestamp, unit and quality metadata.
- `provider_observation`: a value supplied by a named external provider; retain its actual measurement/estimation method.
- `satellite_derived`: a variable retrieved or calculated from satellite products.
- `reanalysis`: a physically consistent historical estimate produced by data assimilation/model systems (e.g. ERA5/ERA5-Land).
- `gridded_model_product`: a spatially gridded model/provider output (e.g. NASA POWER).
- `model_estimate`: output from a NOVA algorithm/model, including model and input versions.
- `scenario_simulation`: output under explicit hypothetical assumptions.
- `synthetic_test_fixture`: artificial data used only for tests, UI demonstrations or pipeline checks.

Do not collapse these into a generic "real-time data" label. Preserve original provider class and the transformation lineage. A provider can publish an observation-derived product without it being a direct observation at the target site.

## 3. Public dataset portfolio and integration order

The URLs below are official provider documentation or catalogues. Availability, terms, access quotas, attribution and API stability must be checked again at implementation time and stored with each connector.

### Tier 1 — first V1 connectors

| Domain | Dataset/provider | What it can support | Correct interpretation / limitations |
|---|---|---|---|
| Weather and agroclimate | NASA POWER Daily API — https://power.larc.nasa.gov/docs/services/api/temporal/daily/ | Daily temperature, humidity, precipitation, wind and solar variables; long historical context | Gridded satellite/reanalysis-derived products at source spatial resolution; not a farm sensor. Specify UTC or LST explicitly. Respect provider limits and avoid repeated catalog-cell requests. |
| Water productivity | FAO WaPOR v3 — https://www.fao.org/in-action/remote-sensing-for-water-productivity/wapor-data-access/en | AETI, evaporation, transpiration, interception, reference ET, NPP and other layer-specific water/land productivity variables | Satellite-derived and model-processed products, not field measurements. FAO documents no API token/credentials for v3 (legacy v2 token guides are outdated). Level 1 is global (~300 m), Level 2 covers Africa/Near East (~100 m), and Level 3 covers selected irrigation schemes/sub-basins (~20 m). Cadence, archive, latency and coverage are layer-specific; verify live catalogue metadata and terms for every request. |
| Solar resource / PV potential | European Commission JRC PVGIS API — https://photovoltaic-geographical-information-system.ec.europa.eu/api/v6/docs | Solar radiation, meteorological context and calculated PV performance/time series | Modelled/resource estimates, not actual inverter output or guaranteed yield. Record technology, tilt, azimuth, losses, horizon and dataset/version assumptions. API version and coverage are subject to change. |
| Climate / land reanalysis | Copernicus ERA5 and ERA5-Land — https://climate.copernicus.eu/climate-reanalysis | Hourly historical meteorological and land variables for baselines, hindcasts and model features | Reanalysis, not point observations. ERA5 is about 0.25-degree grid; ERA5-Land about 9 km. ERA5T is preliminary near-real-time data and can be revised. Respect dataset-specific license and citation instructions. |

### Tier 2 — geospatial and sector-specific extensions

| Domain | Dataset/provider | What it can support | Correct interpretation / limitations |
|---|---|---|---|
| Land/crop/water mapping | Copernicus Sentinel-2 via Copernicus Data Space — https://dataspace.copernicus.eu/data-collections/copernicus-sentinel-missions/sentinel-2 | Surface reflectance, vegetation indices, land cover and change analysis | Satellite observations/products, not crop truth labels. Cloud, atmospheric correction, revisit, resolution, processing baseline and coverage affect results. Level 1C global coverage; check current Level 2A coverage and processing status. |
| Electricity system research | Open Power System Data — https://data.open-power-system-data.org/ | Historical European load, generation, wind/solar and price series; benchmarking grid analytics | Geography is European and package freshness is limited (time-series package documented through mid-2020). Not a Tunisia grid feed and not live telemetry. Use only where geography/time coverage match the task. |

### Excluded until revalidated

- NREL PVDAQ V3 API: provider documentation states the V3 API has been decommissioned. Do not build against the retired endpoint; evaluate the replacement PVDAQ data map and current programmatic access independently.
- Any scraped, unofficial mirror, undocumented endpoint, or dataset with unclear rights: do not ingest into the production data catalog until its origin, license and permitted use are reviewed.

## 4. Connector contract

Each provider connector must be server-side and implement the same conceptual lifecycle:

1. **Discover:** provider, dataset, version, variables, spatial/temporal coverage, resolution, terms, attribution, update cadence and access method.
2. **Request:** validate geographic bounds, time range, variable list, request size and provider quotas before network activity.
3. **Retrieve:** HTTPS only, explicit timeout, bounded response bytes, retry/backoff only for transient errors, no secrets in logs, no open proxy.
4. **Parse:** schema/type checks, finite numeric values, valid units, timestamps/timezones, null/missing sentinel handling and provider error payload detection.
5. **Normalize:** convert to the NOVA observation contract while retaining original variable name, unit, aggregation period, spatial cell/polygon, provider product/version and method.
6. **Quality-control:** flag missingness, range anomalies, duplicates, outliers, spatial mismatch, temporal mismatch, cloud contamination where applicable, and revisions.
7. **Persist:** content hash, retrieval timestamp, request parameters, source record, license/attribution and lineage. Do not persist until D1 readiness and retention policy are approved.
8. **Expose:** return data with evidence class, source citation, temporal/spatial resolution and limitations; never hide stale or partial results.

Connectors must not silently substitute a different dataset when a provider fails. A fallback is a distinct source and must be labelled as such.

## 5. Scientific validation rules

### Data preparation

- Preserve raw provider responses (or reproducible source references and hashes where redistribution is not permitted) separately from normalized features.
- Store units explicitly and use a canonical unit system only after conversion tests.
- Normalize timestamps to UTC while retaining source timezone/time standard and original timestamp.
- Record spatial support: point, pixel/grid cell, polygon aggregate, administrative region or system-wide aggregate.
- Do not upsample coarse grids and imply that this creates finer physical information.
- Distinguish missing values from zero; do not interpolate without recording the method and uncertainty.
- Keep raw, cleaned, feature and label datasets versioned separately.

### Model training and evaluation

- Define the prediction target, forecast horizon, unit, operational decision and baseline before training.
- Use chronological train/validation/test splits for time-dependent tasks. Fit scalers, imputers and feature selection only on training data.
- Use a final untouched test period; add geographic/site holdouts when generalization across locations is claimed.
- Prevent leakage from future weather, target-derived features, overlapping windows, duplicate records and revised provider data.
- Compare against meaningful baselines (persistence, seasonal naive, climatology or transparent physical/deterministic model).
- Report sample count, time range, geography, missingness, baseline score, model score and uncertainty.
- Regression: report MAE and RMSE at minimum; add bias and skill relative to baseline. Use task-appropriate metrics for classification, ranking or probabilistic forecasts.
- For probabilistic forecasts, assess calibration and interval coverage, not only point error.
- Evaluate performance by season, geography, asset/crop class and relevant operating regime. Report where performance degrades.
- Do not claim causality from correlation or feature importance.
- Do not use a synthetic dataset as evidence of real-world predictive accuracy.

### Release gates

A model may be labelled:
- `research`: reproducible experiment, no operational claims;
- `evaluated`: untouched holdout and baseline comparison completed, metrics and limitations published;
- `shadow`: running on current inputs without influencing decisions, with drift/quality monitoring;
- `decision_support`: approved for human-reviewed recommendations within a defined scope;
- `retired`: superseded, unsafe, stale or no longer supported.

No model may move directly from research to decision_support. Infrastructure recommendations remain human-review-only; no autonomous actuation or critical control.

## 6. Domain learning roadmap

### NeoAgro

- Weather/agroclimate: daily/hourly weather features, heat stress indicators, rainfall anomalies and evapotranspiration context.
- Water: FAO WaPOR ETa/RET and water productivity layers; water-balance calculations only when required inputs and assumptions are explicit.
- Vegetation: Sentinel-2 reflectance/indices with cloud and quality masks; distinguish vegetation signal from crop type, yield or plant health labels.
- Crop intelligence: crop calendar, crop-specific phenology and stress models require crop, cultivar, planting date, management and local validation labels. Do not infer a confirmed crop from imagery alone.
- Irrigation: water demand estimates require soil, crop stage, weather, irrigation method and efficiency assumptions. Recommendations must show uncertainty and operator review.

### NeoGrid

- Resource assessment: PVGIS and NASA POWER solar/weather history; preserve resource model assumptions.
- PV performance: transparent physical baseline using irradiance, temperature, module/inverter/system parameters and documented losses.
- Storage: state-of-charge and degradation models require chemistry, capacity, power limits, efficiency, temperature and cycle history. Never invent battery telemetry.
- Forecasting: train load/generation forecasts only where matching historical time series and target labels exist. Use OPSD only for supported European geographies; do not treat it as Tunisian grid data.
- Optimization: begin with offline, constraint-checked simulations; require validated inputs, safety constraints and human approval before any operational recommendation.

### NeoCell

- Asset registry and digital twins: asset identity, topology, units, calibration, firmware, maintenance and provenance.
- Sensor quality: missingness, drift, stuck values, range checks, clock skew and cross-sensor consistency.
- Predictive maintenance: requires labelled failure/maintenance history and exposure time; without labels, deliver condition monitoring and anomaly flags, not failure predictions.
- Edge/gateway integration: signed device identity, source grants, replay protection, sequence numbers, time sync and bounded payloads.
- All control remains advisory; no autonomous critical infrastructure actions.

## 7. Investor/partner evidence package

NOVA OS should present a transparent evidence panel for each capability:

- **Live source status:** last successful retrieval, provider, data age and failure state.
- **Coverage:** geography, period, spatial resolution, temporal resolution and missingness.
- **Evidence class:** field, provider, satellite-derived, reanalysis, model estimate or simulation.
- **Method:** formula/model version, assumptions, feature lineage and parameter values.
- **Validation:** test period, geography, sample count, baseline, metrics and uncertainty.
- **Limitations:** where it is not validated, what inputs are missing and what requires partner/site data.
- **Impact:** only measured against an explicit baseline with traceable inputs; otherwise show "not yet measured".
- **Auditability:** source citation, data version/hash, experiment ID and model release ID.

A credible demo can show real historical open data and reproducible retrospective experiments without claiming a customer deployment, farm measurement, grid telemetry, savings or validated operational forecast.

## 8. No-site operating mode

Until a pilot is approved:

- Keep `sites`, `assets` and site-bound `sources` unseeded.
- Allow research jobs to use explicit user-supplied study coordinates or named public geographies, clearly scoped as analysis requests rather than registered customer sites.
- Global provider datasets may be catalogued with no site ID, but a dataset catalogue record is not an operational source registration.
- Never reuse connectivity-test coordinates as a pilot.
- Use public datasets and archived research notebooks for reproducible tests; synthetic fixtures remain test-only.
- Do not publish a site-specific performance or impact claim without a site and appropriate evidence.

## 9. Implementation backlog

Recommended order:

1. **Dataset catalogue schema and source metadata:** provider/dataset/version, license, attribution, coverage, resolution, update cadence, evidence class and access requirements.
2. **Connector SDK and conformance tests:** shared timeout, size, parsing, provenance, unit, timestamp and error rules.
3. **PVGIS connector:** complementary solar resource and modelled PV potential; explicit request coordinates and assumptions; no site registration required.
4. **FAO WaPOR connector:** water/ET layers with spatial/temporal coverage checks and lineage.
5. **ERA5/ERA5-Land pipeline:** reproducible historical climate features and baselines.
6. **Sentinel-2 processing:** cloud-aware imagery and vegetation features, initially offline/batch.
7. **Experiment registry:** immutable dataset snapshots/hashes, split definitions, code commit, parameters, metrics and model artifacts.
8. **Evaluation service:** baselines, temporal/geographic holdouts, calibration, drift and model cards.
9. **NOVA OS evidence UI:** show source health, provenance, method and measured validation—not decorative AI scores.

Each connector gets its own draft PR, tests with recorded provider fixtures, a small live smoke test only when safe, and explicit attribution. No connector should write into D1 until storage, identity, retention and billing gates are approved.

## 10. Sources and references

- NASA POWER Daily API: https://power.larc.nasa.gov/docs/services/api/temporal/daily/
- NASA POWER dataset overview: https://data.nasa.gov/dataset/prediction-of-worldwide-energy-resources-power
- FAO WaPOR access methods and API: https://www.fao.org/in-action/remote-sensing-for-water-productivity/wapor-data-access/en
- FAO WaPOR data and levels: https://www.fao.org/in-action/remote-sensing-for-water-productivity/wapor-data/
- PVGIS JRC API v6: https://photovoltaic-geographical-information-system.ec.europa.eu/api/v6/docs
- PVGIS JRC overview: https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis_en
- Copernicus ERA5/ERA5-Land: https://climate.copernicus.eu/climate-reanalysis
- Copernicus Data Space documentation: https://documentation.dataspace.copernicus.eu/
- Sentinel-2 data overview: https://dataspace.copernicus.eu/data-collections/copernicus-sentinel-missions/sentinel-2
- Open Power System Data: https://data.open-power-system-data.org/
- NREL PVDAQ status (V3 API decommissioned): https://developer.nlr.gov/docs/solar/pvdaq-v3/

Provider terms, attribution and quota limits are dataset-specific. This catalogue is a starting point, not a blanket license grant.
