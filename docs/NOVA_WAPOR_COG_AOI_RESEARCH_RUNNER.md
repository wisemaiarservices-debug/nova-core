# NOVA WaPOR COG AOI research runner

**Status:** opt-in local research CLI. No public API, scheduled task, hosted workflow, site registration, storage or deployment is configured.

## Provider workflow

The runner uses the existing bounded FAO WaPOR v3 catalogue reader:

1. Discover the requested mapset and exact raster record.
2. Require a dekadal raster code and verify the catalogue period start against the code.
3. Validate the provider-supplied download URL against the exact `storage.googleapis.com/fao-gismgr-wapor-3-data` bucket and object path for that mapset/raster.
4. Perform a no-redirect HTTPS HEAD and exact four-byte TIFF signature range preflight; require the range's total size to match HEAD.
5. Open only a GDAL-identified Cloud Optimized GeoTIFF with redirect following disabled and bounded timeout/cache settings.
6. Validate caller-supplied WGS84 geometry structurally and with Shapely topology checks, transform it into the raster CRS, and calculate a boundless AOI window; reject the request if any part of the AOI falls outside the raster footprint.
7. Enforce a 10-million-pixel window limit and single-band supported sample dtypes; apply the provider mask, NoData sentinel and finite-value mask. Pixel inclusion uses the pixel-center rule (`all_touched=False`).
8. Count valid, NoData/invalid and outside-AOI pixels separately; compute raw statistics and emit an immutable checksum-bound processing manifest.

Only dekadal mapsets and raster codes are supported in this first version. Monthly/annual rasters, multi-band assets, non-COG GeoTIFFs and unsupported dtypes are rejected rather than guessed.

## URL, range and resource controls

- No arbitrary URL input: mapset/raster codes are resolved from FAO's catalogue and the returned URL must match the exact HTTPS host, bucket and object path.
- URL credentials, non-default ports, parameters, query strings, fragments, encoded path variants, unexpected hosts/paths and redirects are rejected.
- HEAD requires a numeric Content-Length between 8 bytes and 256 MiB.
- Initial GET must return HTTP 206, Content-Length 4, exact `Content-Range: bytes 0-3/{object-size}`, and the classic TIFF byte-order/magic prefix.
- GDAL redirect following is disabled; HTTP retries are disabled; request timeout is bounded; only `.tif` remote objects are enabled.
- AOI input JSON is capped at 1 MiB; the geometry validator enforces polygon/ring/position caps; Shapely rejects invalid polygon topology.
- The full AOI must fit inside the raster footprint; partial coverage is rejected rather than silently clipped. The crop is capped at 10 million pixels and a single band. Only a bounded set of 8/16/32-bit integer and 32/64-bit float dtypes is supported.
- The full remote COG is not downloaded. `source_object_sha256` remains null; `processed_window_sha256` hashes exact crop samples, inside/valid masks, dtype, CRS, transform and pixel window.
- The source object's size is bounded, but this version does not meter cumulative HTTP range bytes independently of GDAL. Do not raise the object-size cap without a separate transfer-budget implementation.

## Scientific provenance

- Evidence class is fixed to `satellite_derived`.
- Provider period and retrieval timestamp are distinct; catalogue period must match the dekadal code.
- Source dtype and NoData sentinel are recorded separately from raw statistics.
- No scale/offset calibration is applied until authoritative per-raster calibration metadata is verified.
- Units are used only when present in FAO mapset metadata; no units are inferred from layer codes.
- Pixels inside the crop whose centers fall outside the polygon are counted separately from provider NoData/invalid pixels; this is not fractional pixel-area accounting.
- The manifest `site_id` is fixed to null. AOI is caller-supplied research geometry only.
- No raster file, database record, D1 write, artifact, site/source identity or telemetry is persisted.

## Local invocation

Install the pinned research-only dependencies from `requirements-research.txt`. Set the following environment variables in a local environment that is permitted to access the public FAO endpoints:

- `NOVA_WAPOR_MAPSET_CODE`
- `NOVA_WAPOR_RASTER_CODE`
- `NOVA_WAPOR_AOI_GEOJSON` (at most 1 MiB)
- `NOVA_PROCESSING_CODE_COMMIT` (or `GITHUB_SHA` when running in an existing CI context)

Then run `python -m scripts.wapor_cog_aoi`. The result is printed as JSON and no output file is written. Do not place private/customer AOI coordinates in shared logs.

No GitHub-hosted workflow is included: the available included-runner allowance and overage state have not been verified, and project policy prohibits paid usage or overages. This runner has not been invoked against FAO or a live COG in this PR.

## Current limits

This is research evidence, not a validated forecast, recommendation or operational control signal. It does not create a customer site, validate an irrigation/energy model, compute zonal summaries, prove field performance or trigger physical actuation.
