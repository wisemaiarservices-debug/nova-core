# NOVA bounded WaPOR GeoTIFF statistics

## Scope

`apps/api/services/geotiff_statistics.py` adds an offline, bounded pixel-statistics stage for a deliberately narrow classic TIFF subset. It accepts an already supplied byte string; it does not fetch provider URLs or write files.

Supported input:
- Single-band, chunky TIFF.
- Uncompressed strips only (`Compression=1`).
- Predictor 1 only.
- 8/16/32-bit unsigned or signed integer samples and 32/64-bit floating samples.
- A strip layout whose offsets and byte counts exactly match image dimensions.
- At most 10 million pixels and the existing 16 MiB byte-input cap.

Unsupported layouts fail closed: BigTIFF, tiles, compression, multiple bands, planar-separate samples, packed sub-byte samples, predictors, unsupported bit depths, and malformed strip ranges.

## Statistics and evidence

NoData is excluded from min/max/mean. An all-NoData raster returns null statistics and zero valid pixels, never a fabricated zero-valued mean. Raw values are always reported. Calibrated values are calculated only when both explicit GDAL scale and offset metadata are present. Units are never inferred from raster codes or numeric magnitudes.

Outputs remain `satellite_derived`; they are not field measurements. Statistics cover the full raster and are not zonal summaries or clipped to a study area.

## Integration boundary

This is a tested service function only. It is not wired to the WaPOR HTTP API, does not dereference `downloadUrl`/`gsutilUri`, does not decode compressed GeoTIFFs, and does not persist results or register a site, asset or source. Before a future downloader is added, the provider's exact download host, URL semantics, redirects, content type, TIFF magic, byte cap, timeouts and geographic limits must be independently verified and enforced.

## Next gates

1. Verify the official WaPOR v3 download URL behavior and permitted hosts from FAO's current tutorial/API responses.
2. Add explicit research-area polygon/bounds validation and raster intersection checks; do not assume a pilot site exists.
3. Attach source/mapset/raster code, provider period semantics, retrieval timestamp, content checksum, processing commit, CRS, units and licence/attribution to a reproducible experiment manifest.
4. Add zonal statistics only after a correct CRS-aware geometry/raster intersection implementation exists.
