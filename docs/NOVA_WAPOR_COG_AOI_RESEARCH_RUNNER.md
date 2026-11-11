# NOVA WaPOR COG AOI research runner

**Status:** manual, research-only GitHub Actions workflow. It is not an API endpoint, scheduled job, site registration flow, or production service.

## Provider workflow

The runner follows the FAO WaPOR v3 API tutorial:

1. Discover the requested mapset through the official WaPOR v3 catalogue.
2. Discover the exact raster record in that mapset.
3. Validate its provider-supplied downloadUrl against the exact FAO Google Cloud Storage host, bucket, mapset and raster object path.
4. Perform a no-redirect HTTPS HEAD and four-byte TIFF signature preflight.
5. Open the Cloud Optimized GeoTIFF with GDAL/rasterio HTTP range reads and no redirect following.
6. Validate the caller-supplied WGS84 AOI, require valid polygon topology, transform it into the raster CRS, read only the intersecting crop window, and enforce the 10-million-pixel cap.
7. Exclude provider NoData and invalid mask pixels, separately count pixels outside the polygon, compute raw statistics, and emit a checksum-bound processing manifest.

The runner supports dekadal mapsets and raster codes only in this first version. Monthly/annual rasters and multi-band assets are rejected rather than guessed.

## Security and resource bounds

- No arbitrary URL input: mapset/raster codes are resolved from FAO's catalogue and the returned URL must match the exact storage.googleapis.com bucket/object path.
- HTTPS only; rejects URL credentials, query strings, fragments, unexpected hosts/paths and HTTP redirects.
- Preflight requires a bounded Content-Length no larger than 1 GiB and validates the TIFF byte-order/magic prefix.
- GDAL redirect following is disabled; only .tif remote objects are enabled.
- AOI structural limits come from the Core validator; Shapely additionally rejects invalid polygon topology.
- The cropped pixel window is capped at 10 million pixels; only one band is accepted.
- GitHub workflow is workflow_dispatch only, one job, ten-minute timeout, read-only repository permission and no secrets.
- No raster file, database record, D1 write, artifact, site/source identity or telemetry is persisted.

The GitHub Actions run uses the repository's included hosted-runner allowance. Do not enable billing, upgrade plans, or add paid services. If the account indicates that a paid runner or additional usage commitment is required, stop and use an already available free local environment instead.

## Provenance semantics

- The output evidence class is fixed to satellite-derived.
- Provider period and retrieval timestamp are distinct.
- processed_window_sha256 hashes the exact cropped samples, inside/valid masks, CRS, transform and window coordinates. It is not misrepresented as a checksum of the complete remote COG.
- source_object_sha256 remains null because the full source object is not downloaded.
- Units are used only when present in the provider mapset metadata; no units are inferred from layer codes.
- No scale/offset calibration is applied until authoritative per-raster calibration metadata is verified.
- The manifest site_id is fixed to null. AOI is caller-supplied research geometry only.

## Manual use

Open Actions → NOVA WaPOR AOI Research Processing → Run workflow. Supply:
- a dekadal mapset code, such as L2-AETI-D;
- an exact raster code returned by the mapset raster index;
- a valid GeoJSON Polygon or MultiPolygon in longitude/latitude order.

The result is printed as JSON in the workflow log. The workflow does not upload artifacts or persist the raster. Never paste private/customer coordinates unless authorized for this research run.


The manifest retains the raster sample dtype and the provider's NoData sentinel as separate source metadata. Raw statistics are calculated only after the provider mask, NoData sentinel, finite-value check and AOI mask are applied. This does not apply scale/offset calibration or infer physical units.
