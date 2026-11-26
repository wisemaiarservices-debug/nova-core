# NOVA bounded WaPOR GeoTIFF statistics

## Scope

`apps/api/services/geotiff_statistics.py` adds an offline, bounded pixel-statistics stage for a deliberately narrow classic TIFF subset. It accepts an already supplied byte string; it does not fetch provider URLs or write files.

Supported input:
- Single-image, single-band, chunky TIFF.
- Uncompressed strips only (`Compression=1`).
- Predictor 1 only.
- 8/16/32-bit unsigned or signed integer samples and 32/64-bit floating samples.
- A strip layout whose offsets and byte counts exactly match image dimensions.
- At most 4,096 strips, 10 million pixels and the existing 16 MiB byte-input cap.

Unsupported layouts fail closed: BigTIFF, multiple IFD/images, tiles, compression, multiple bands, planar-separate samples, packed sub-byte samples, predictors, unsupported bit depths, unsupported TIFF field types, duplicate tags, overlapping strip ranges, strips overlapping metadata and malformed strip ranges.

## Statistics and evidence

NoData is excluded from min/max/mean. An all-NoData raster returns null statistics and zero valid pixels, never a fabricated zero-valued mean. Raw integer min/max values preserve their integer type. The running mean uses scaled incremental accumulation to avoid overflow from summing large finite samples. Calibrated values are calculated only when both explicit GDAL scale and offset metadata are present; non-finite samples or calibrated overflow are rejected. Units are never inferred from raster codes or numeric magnitudes.

Outputs remain `satellite_derived`; they are not field measurements. Statistics cover the full raster and are not zonal summaries or clipped to a study area.

## Strip integrity

The service validates the first IFD and strip/sample field types, rejects duplicate tags, bounds strip arrays to 4,096 entries, requires exact per-strip byte counts, checks each range against the input buffer, and rejects overlapping external metadata blocks plus strip overlap with the TIFF header, IFD, external metadata values or another strip. Multi-image TIFFs are rejected. These checks prevent a malicious or malformed strip index from repeatedly counting the same bytes or interpreting metadata as pixel samples.

## Integration boundary

This is a tested service function only. It is not wired to the WaPOR HTTP API, does not dereference `downloadUrl`/`gsutilUri`, does not decode compressed GeoTIFFs, and does not persist results or register a site, asset or source. Before a future downloader is added, the provider's exact download host, URL semantics, redirects, content type, TIFF magic, byte cap, timeouts and geographic limits must be independently verified and enforced.

## Test coverage

Synthetic fixtures exercise single- and multi-strip layout, NoData exclusion, all-NoData behavior, explicit scale/offset, big numeric samples, non-finite sample rejection, strip overlaps, metadata overlaps, duplicate strip tags, byte-count mismatch, strip-count cap, multi-IFD rejection and compressed-strip rejection. These fixtures are test-only and do not represent a real WaPOR raster.

## Next gates

1. Verify the official WaPOR v3 download URL behavior and permitted hosts from FAO's current tutorial/API responses.
2. Add explicit research-area polygon/bounds validation and raster intersection checks; do not assume a pilot site exists.
3. Attach source/mapset/raster code, provider period semantics, retrieval timestamp, content checksum, processing commit, CRS, units and licence/attribution to a reproducible experiment manifest.
4. Add zonal statistics only after a correct CRS-aware geometry/raster intersection implementation exists.
