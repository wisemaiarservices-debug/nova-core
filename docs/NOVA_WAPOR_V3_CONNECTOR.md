# NOVA FAO WaPOR v3 metadata discovery

**Status:** read-only mapset and raster-index metadata discovery is implemented as a candidate connector. GeoTIFF raster download, pixel processing, persistence and site linkage are not implemented.

## Official provider contract

FAO's WaPOR v3 API exposes the GISMGR 2.0 catalogue endpoint:

`https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets`

A mapset's raster index is exposed at:

`{mapsets_endpoint}/{mapset_code}/rasters`

Provider responses are wrapped in `response`, with `items` and pagination `links`. Pagination links are treated as untrusted input and revalidated against the fixed FAO HTTPS host and exact catalogue/mapset-raster path. FAO documents that v3 API access does not require an API key, token or credentials; legacy v2 token instructions do not apply.

References:
- https://www.fao.org/in-action/remote-sensing-for-water-productivity/wapor-data-access/en
- https://github.com/un-fao/FAO-Water-Applications/blob/main/WaPOR/WaPORv3_API.ipynb
- https://data.apps.fao.org/gismgr/shared/docs/api-reference/index.html

## NOVA endpoints

### `GET /api/v1/data/water/wapor/mapsets`

Lists current mapset metadata and provenance. The operation is bounded to 8 pages, 2,000 items, 1 MiB per response page, 15 seconds per upstream request and 60 seconds total. Pagination cycles, ambiguous/malformed links, invalid envelopes and untrusted paths are rejected. The response reports `truncated` only when a safety cap actually prevents further enumeration.

### `GET /api/v1/data/water/wapor/rasters?mapset_code=L2-AETI-D&start_date=2024-01-01&end_date=2024-03-31`

Confirms the mapset exists in the current catalogue before listing its raster index. Optional date filtering uses the period encoded in each raster code. Unparseable codes are excluded when date filtering is requested and counted in `unparsed_date_count`. For dekadal products, `period_start` is the first day of that dekad (D1=day 1, D2=day 11, D3=day 21), not an instantaneous observation timestamp.

Download references are returned only when they match the explicit HTTPS storage-host allow-list or a constrained `gs://` URI form. These are metadata only; NOVA does not dereference them.

## Security and data controls

- HTTPS only, exact FAO host, exact catalogue/mapset-raster path; pagination URLs are revalidated before every request.
- Redirects rejected; JSON media type required; incremental response-byte checks before Pyodide copies typed-array chunks.
- AbortController cancellation on timeout/error; 15-second per-request and 60-second total-operation deadlines.
- Bounded page bytes, page count, item count, mapset codes, text metadata and output references.
- No arbitrary URL, host, file path or provider proxy parameter is accepted.
- No GeoTIFF is downloaded, decompressed or processed by this connector.
- No D1 writes, no site/asset/source registration and no secrets.
- Results are explicitly labelled `satellite_derived`; they are not ground-truth field measurements.
- Mapset existence does not establish geographic coverage for a user polygon. Layer metadata and per-request coverage must be checked before future pixel processing.
- Historical Level 3 corrections/re-releases mean product version, retrieval time, source URL, raster checksum, units, scale/offset, NoData, CRS, affine transform, spatial bounds and processing lineage must be retained by any future raster pipeline.

## Deferred work

1. Validate a small, explicitly selected FAO raster download with a strict byte cap and safe GeoTIFF parser.
2. Add polygon/area-of-interest clipping and spatial coverage validation without assuming a pilot location.
3. Add unit/scale/NoData handling based on per-layer metadata, never inferred from variable names.
4. Add research outputs and QC summaries; only persist after D1, retention, identity and billing gates are approved.
