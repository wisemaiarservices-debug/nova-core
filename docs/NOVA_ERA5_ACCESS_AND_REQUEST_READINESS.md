# NOVA Copernicus ERA5 / ERA5-Land access readiness

**Status:** research connector not implemented. This document defines access, dataset selection and request-safety gates only. No CDS account, API token, request submission, download, dependency, persistent storage or deployment is configured.

## Verified CDS access prerequisites

The official Copernicus Climate Data Store (CDS) API setup currently requires:

1. A registered and authenticated CDS account.
2. A personal API access token configured in a local `$HOME/.cdsapirc` or an approved server-side secret store. The current example uses `url: https://cds.climate.copernicus.eu/api` and a personal access token.
3. Manual acceptance of the applicable dataset Terms of Use on the dataset page before programmatic download.
4. The current dataset-specific API request generated from the CDS download form; do not copy a stale request template and assume it remains valid.

The official setup currently recommends `cdsapi>=0.7.7`. ECMWF also offers `ecmwf-datastores-client` as an advanced package with metadata retrieval and synchronous/asynchronous job submission. It is still classified as *Incubating*; ECMWF advises using a released tag in operational systems and notes that users are not required to migrate from `cdsapi`. The REST API is not supported. NOVA should not add either dependency until the target runtime, package size, asynchronous job behavior and API maturity have been reviewed.

## Candidate datasets and current catalogue facts

| Dataset | Coverage and resolution | Temporal coverage and cadence | Format and DOI |
|---|---|---|---|
| ERA5 hourly data on single levels from 1940 to present (`reanalysis-era5-single-levels`) | Global; regular latitude/longitude; 0.25° x 0.25° atmosphere grid. Ocean-wave and uncertainty products have different grids. | 1940 onward; hourly; updated daily. | GRIB; NetCDF4 is marked experimental on the current form. DOI: `10.24381/cds.adbb2d47`. |
| ERA5-Land hourly data from 1950 to present (`reanalysis-era5-land`) | Global; regular latitude/longitude; 0.1° x 0.1° (native resolution approximately 9 km). | January 1950 onward; hourly; updated daily. | GRIB; NetCDF4 is marked experimental on the current form. DOI: `10.24381/cds.e2161bac`. |

These values were checked against the current CDS catalogue on 26 November 2026. The live dataset page and its generated API request remain authoritative for actual variable, date, format, grid and product availability.

ERA5 is a global reanalysis: model data are combined with observations through data assimilation to create a spatially and temporally consistent estimate. ERA5-Land replays the land component using ERA5 atmospheric forcing; observations are not directly assimilated into the ERA5-Land land fields themselves. Both products are gridded reanalysis estimates, not local weather-station or field-sensor observations. ERA5-Land documentation explicitly notes uncertainty and that uncertainty generally increases further back in time as the atmospheric forcing has fewer observations.

The ERA5-Land catalogue also exposes an analysis-ready, cloud-optimised (ARCO) Zarr subset for selected variables. This is a repackaged subset, not a guarantee that all ERA5-Land variables are available in that form; the CDS documentation states that API credentials are still required for access.

## Request safety contract

A future connector must require an explicit research request containing:

- exact CDS dataset identifier copied from the current catalogue;
- exact variable identifiers and product type from the generated request;
- explicit start/end dates and time selections;
- explicit geographic area in CDS order: north, west, south, east;
- requested output format and grid/resolution where supported;
- an operator-supplied study-area reference, not an assumed customer site;
- a bounded maximum output size and expected number of time steps.

Before submission, estimate request volume and reject unbounded global/multi-year requests by default. Start with a small, explicitly bounded test period and area. Use provider job status and returned metadata to record what was actually delivered. Do not retry indefinitely or submit duplicate jobs blindly. Do not assume that a selected output format or variable remains available; validate against the live dataset form and generated request.

## Credential and terms handling

- Do not ask the user to paste a CDS token into chat, source files, browser code, GitHub issues or PR comments.
- If a connector is later approved, store credentials only in a server-side secret facility after checking that the selected free tier and billing configuration remain acceptable.
- Never include credentials or signed request URLs in logs, exception messages, request manifests or provenance responses.
- Dataset Terms of Use require manual acceptance; a code path cannot accept them on the user's behalf.
- If account registration, terms acceptance, credentials or any paid/upgrade requirement is missing, connector status must remain `unconfigured` and fail closed.

## Scientific provenance

Every retrieved item must retain:

- dataset ID and catalogue DOI/version;
- exact request manifest and a hash of the manifest;
- retrieval timestamp and provider job/request ID;
- provider file checksum and size;
- variables, units, time coordinates, spatial grid and CRS from delivered file metadata;
- reanalysis evidence class and provider attribution/licence;
- missing-data and quality-control notes;
- accumulation/de-accumulation semantics for precipitation, radiation and flux variables;
- the processing code commit and any conversion/regridding method.

ERA5/ERA5-Land values must remain labelled `reanalysis`. They must not be relabelled as `field_observation` or direct station measurements. Any derived crop, irrigation, solar or infrastructure recommendation remains advisory and requires local validation.

## Implementation sequence

1. Build a catalogue metadata reader and schema-conformance tests without credentials.
2. Add a pure request-manifest validator for dataset ID, variable IDs, product type, date range, area order, grid and output format.
3. Estimate request size and impose explicit per-request time-step, area and output-byte budgets.
4. Add a server-only client behind an explicit disabled-by-default configuration gate.
5. Add small bounded integration tests only after dataset terms are accepted and credentials are stored securely.
6. Normalize returned metadata and file provenance before any GRIB/NetCDF/Zarr processing.
7. Add spatial/temporal holdouts and baseline evaluation before any predictive claim.

## Current NOVA status

There is no ERA5 API key, CDS account binding, accepted dataset licence recorded by NOVA, connector, scheduled job, dataset download or field-site linkage. No user action is requested in this PR. This is an engineering readiness note, not evidence of a working ERA5 integration.

## Official references

- CDS API setup and access token instructions: https://cds.climate.copernicus.eu/en/how-to-api
- ERA5 single-level dataset: https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels
- ERA5-Land dataset: https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land
- ERA5-Land analysis-ready Zarr subset: https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land?tab=analysis_ready_data
