# NOVA Copernicus ERA5 / ERA5-Land access readiness

**Status:** research connector not implemented. This document defines the access and request gate only. No CDS account, API token, request submission, download, dependency, persistent storage or deployment is configured.

## Verified access prerequisites

The official Copernicus Climate Data Store (CDS) API instructions currently require:
1. A registered and authenticated CDS account.
2. A personal API access token configured in the user's local `.cdsapirc` or an approved secret store.
3. Manual acceptance of the applicable dataset Terms of Use on the dataset page before programmatic download.
4. The current dataset-specific API request generated from the CDS download form.

The official setup currently documents the `cdsapi` client (version 0.7.7 or later) and also describes the newer `ecmwf-datastores-client` as an incubating advanced client. NOVA should not add either dependency until the intended runtime, deployment size and API stability have been reviewed.

## Candidate datasets

- ERA5 single-level reanalysis: candidate for atmospheric and surface forcing variables.
- ERA5-Land: candidate for land-surface variables and water/energy balance research.

ERA5 and ERA5-Land are reanalysis products, not local weather-station or field-sensor observations. Dataset-specific variables, units, temporal coverage, grid, accumulation conventions and licence terms must be taken from the current CDS catalogue/API metadata at request time. Never infer units from variable labels.

## Request safety contract

A future connector must require an explicit research request containing:
- exact CDS dataset identifier copied from the current catalogue;
- exact variable identifiers and product type from the generated request;
- explicit start/end dates and time selections;
- explicit geographic area in CDS order: north, west, south, east;
- requested output format and grid/resolution where supported;
- an operator-supplied study-area reference, not an assumed customer site.

Before submission, estimate request volume and reject unbounded global/multi-year requests by default. Start with a small, explicitly bounded test period and area. Use provider job status and returned metadata to record what was actually delivered. Do not retry indefinitely or submit duplicate jobs blindly.

## Credential and terms handling

- Do not ask the user to paste a CDS token into chat, source files, browser code, GitHub issues or PR comments.
- If a connector is later approved, store credentials only in a server-side secret facility after checking that the selected free tier and billing configuration remain acceptable.
- Never include credentials in logs, exception messages, request manifests or provenance responses.
- Dataset Terms of Use require manual acceptance; a code path cannot accept them on the user's behalf.
- If account registration, terms acceptance, credentials or any paid/upgrade requirement is missing, connector status must remain `unconfigured` and fail closed.

## Scientific provenance

Every retrieved item must retain:
- dataset ID and catalogue version;
- exact request manifest and a hash of the manifest;
- retrieval timestamp and provider job/request ID;
- provider file checksum and size;
- variables, units, time coordinates, spatial grid and CRS from the delivered file metadata;
- reanalysis evidence class and provider attribution/licence;
- missing-data and quality-control notes;
- the processing code commit and any conversion/regridding method.

ERA5/ERA5-Land values must remain labelled `reanalysis`. They must not be relabelled as `field_observation` or direct station measurements. Any derived crop, irrigation, solar or infrastructure recommendation remains advisory and requires local validation.

## Implementation sequence

1. Build a catalogue metadata reader and schema conformance tests without credentials.
2. Add a pure request-manifest validator for date range, area order, variable IDs and output format.
3. Add a server-only client behind an explicit disabled-by-default configuration gate.
4. Add small bounded integration tests only after dataset terms are accepted and credentials are stored securely.
5. Normalize returned metadata and file provenance before any raster/GRIB/NetCDF processing.
6. Add spatial/temporal holdout and baseline evaluation before any predictive claim.

## Current NOVA status

There is no ERA5 API key, CDS account binding, accepted dataset licence recorded by NOVA, connector, scheduled job, dataset download or field-site linkage. No user action is requested in this PR. This is an engineering readiness note, not evidence of a working ERA5 integration.
