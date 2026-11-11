# NOVA bounded GeoTIFF metadata inspection

**Status:** offline byte-buffer metadata parser. No remote raster download, pixel decoding, reprojection, zonal statistics, persistence, site registration or model validation is implemented.

## Why this stage is deliberately metadata-only

FAO's WaPOR v3 API is publicly accessible without API credentials, and FAO provides a dedicated WaPOR downloader for processing data over an area of interest. Raster assets can be large, so NOVA must not blindly fetch provider-supplied URLs or ingest whole global rasters into a web request.

The current implementation accepts a caller-supplied byte buffer capped at 16 MiB and inspects the TIFF header and first image-file directory only. It does not fetch a URL, follow redirects, write a temporary file or decode image samples. This creates a testable metadata boundary before remote retrieval and geospatial analytics are introduced.

## Metadata inspected

- TIFF byte order and classic TIFF format marker;
- image width, height, pixel count, samples per pixel and bits per sample;
- compression, photometric interpretation, planar configuration, predictor and sample format;
- GeoTIFF model pixel scale, tie points and transformation matrix when present;
- GeoKeyDirectory values, including explicit geographic/projected EPSG keys;
- GDAL NoData, scale and offset metadata when explicitly present.

Unknown or absent fields remain null. EPSG is only reported when explicitly present in the GeoKeyDirectory. No units are inferred from the mapset code or layer name; authoritative layer units must come from the provider's layer metadata. Pixel values, valid-data masks, statistics, raster bounds and area calculations are not produced.

## Limits and failure behavior

- Input type must be bytes; maximum size 16 MiB.
- Classic TIFF only; BigTIFF is explicitly rejected.
- At most 512 first-IFD entries.
- Width and height are bounded to 100,000 each and 100 million total pixels.
- External metadata values must lie entirely inside the supplied byte buffer.
- GeoKeyDirectory must be structurally valid and references must point to supported GeoKey parameter tags.
- Malformed, truncated, oversized or unsupported metadata raises `GeoTiffError`; the caller should treat the asset as uninspected.

These limits are defensive parser bounds, not claims about WaPOR's actual raster sizes.

## Security follow-up

The WaPOR API metadata currently contains provider-supplied download URL fields. This PR does not dereference them. Before adding a downloader, inspect current official v3 notebook/API responses and establish the real host, URL shape, content type, redirect behavior and access semantics. Then enforce a strict host allowlist, HTTPS, redirect rejection, response byte cap, timeout, content validation and a study-area/window limit. Do not treat a signed URL as a trusted URL merely because it was returned by a provider API.

## Scientific follow-up

A future processing stage must preserve the exact provider mapset, raster code, period semantics, layer version/revision, source URL identity (without exposing signed query secrets), retrieval time, licence/attribution, CRS, transform, NoData, scale/offset and authoritative unit. Pixel decoding and resampling must preserve NoData and apply scale/offset only when documented. Any derived values must record the algorithm and spatial/temporal aggregation.

WaPOR is satellite-derived/model-processed evidence, not a field sensor reading. Near-real-time dekadal products may later be replaced by final quality-improved products, so snapshot identity and retrieval version matter. A future study-area analysis requires an explicitly supplied polygon or bounding box; no pilot site or coordinates are assumed.

## Runtime and deployment

This module is an internal Python library with no new API endpoint. It adds no dependency, public route, D1 write, file store, worker, credential or paid service. It is suitable for offline unit tests, but it has not been deployed or tested against a live WaPOR raster.
