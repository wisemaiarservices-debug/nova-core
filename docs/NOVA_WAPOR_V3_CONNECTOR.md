# NOVA FAO WaPOR v3 metadata connector

**Status:** read-only metadata discovery implemented; GeoTIFF raster download, pixel processing, persistence and site linkage are not implemented.

## Official provider contract

FAO's WaPOR v3 tutorial documents the GISMGR 2.0 catalogue endpoint:

`https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets`

Mapsets expose raster indexes at:

`{mapsets_endpoint}/{mapset_code}/rasters`

The provider response is wrapped in `response`, with `items` and pagination `links`. The official FAO notebook demonstrates following the `next` link and reading raster `code`, `downloadUrl`, and `gsutilUri`. FAO states that v3 API access requires no token or credentials. References:
- https://www.fao.org/in-action/remote-sensing-for-water-productivity/wapor-data-access/en
- https://github.com/un-fao/FAO-Water-Applications/blob/main/WaPOR/WaPORv3_API.ipynb
- https://data.apps.fao.org/gismgr/shared/docs/api-reference/index.html

## NOVA endpoints

### `GET /api/v1/data/water/wapor/mapsets`

Returns the current mapset catalogue, provider captions and available metadata. Pagination is bounded to 8 pages and 2,000 items; response pages are limited to 1 MiB and network timeout to 15 seconds. The response reports `truncated` when the safety cap is reached.

### `GET /api/v1/data/water/wapor/rasters?mapset_code=L2-AETI-D&start_date=2024-01-01&end_date=2024-03-31`

First confirms the mapset code is present in the current catalogue, then lists matching raster index records. Optional date filtering uses the date encoded in the provider raster code. For dekadal products the returned `period_start` is the first day of that dekad (D1=day 1, D2=day 11, D3=day 21); it is a period marker, not an instantaneous timestamp.

## Security and data controls

- HTTPS only, fixed FAO host and API path; pagination URLs are revalidated before every request.
- Redirects rejected; JSON content type required; bounded page bytes, page count, item count and request timeout.
- No arbitrary URL, host, file path or provider proxy parameter is accepted.
- No GeoTIFF is downloaded, decompressed or processed by this connector.
- No D1 writes, no site/asset/source registration and no secrets.
- Results are explicitly labelled `satellite_derived`; they are not ground-truth field measurements.
- Mapset existence does not establish geographic coverage for a user polygon. Layer metadata and per-request coverage must be checked before future pixel processing.
- The provider's NRT dekadal layers may be replaced by final quality-improved versions. A future raster pipeline must retain product version, retrieval time, source URL, raster checksum, units, scale/offset, NoData, CRS, affine transform, spatial bounds and processing lineage.

## Deferred work

1. Validate a small, explicitly selected FAO raster download with a strict byte cap and safe GeoTIFF parser.
2. Add polygon/area-of-interest clipping and spatial coverage validation without assuming a pilot location.
3. Add unit/scale/NoData handling based on per-layer metadata, never inferred from variable names.
4. Add research outputs and QC summaries; only persist after D1, retention, identity and billing gates are approved.
