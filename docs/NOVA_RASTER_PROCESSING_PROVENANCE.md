# NOVA raster processing provenance contract

**Status:** immutable, offline validation model only. No raster retrieval, storage, experiment persistence, site registration, or deployment is implemented.

## Required lineage

A processing manifest binds one output to the exact provider asset and code that produced it:

- provider and dataset identity/version;
- WaPOR mapset and raster codes;
- provider period start/end (the provider's temporal interval, not the download time);
- timezone-aware retrieval timestamp;
- SHA-256 of the normalized AOI-window pixel data, validity mask and spatial window metadata;
- optional SHA-256 of the complete source COG object, populated only when the entire object is actually downloaded and hashed;
- optional SHA-256 of the provider metadata snapshot;
- exact 40-character processing-code commit and named processing method;
- processed AOI-window dimensions, original source-raster dimensions, source sample dtype and NoData sentinel, and separate valid/NoData/outside-AOI pixel counts;
- raw statistics and optional calibrated statistics;
- optional CRS and affine transform only when explicitly normalized from authoritative metadata;
- optional study-area geometry hash and WGS84 bounding box.

The processed-window checksum is a canonical hash of the selected pixel window, its validity mask and the spatial metadata needed to interpret it. It is not represented as a hash of the complete remote COG. The optional source-object checksum is populated only after a full-object download and hash. A provider item code is an identity, not proof that the bytes are authentic.

## Scientific semantics

- Every record is satellite-derived; it must not be represented as a field sensor observation.
- Provider period is distinct from retrieval timestamp.
- Raw values are preserved as raw statistics. Calibration is valid only when both explicit scale and offset are recorded; the model rejects partial calibration.
- Units remain null unless supplied by authoritative, versioned provider layer metadata. The manifest never infers units from a code or variable name.
- Valid plus NoData pixel counts must equal width × height. All-NoData rasters have null statistics, not zero-valued statistics.
- CRS and affine transform are optional because the current metadata inspector does not yet prove a complete spatial transform for every GeoTIFF variant.
- The current statistics processor covers the entire supplied raster. An AOI hash records intended research geometry only; it does not claim that the raster was clipped or that zonal statistics were calculated.

## Research-only identity boundary

site_id is fixed to null. This model does not register a customer site, asset, provider source, or pilot. A future experiment can link to a raster manifest by its stable manifest_id and checksum without converting a research AOI into an operational site.

## Not implemented

No API endpoint, D1 table/binding, downloader, object store, retention policy, scheduled job, mapset/raster retrieval workflow, clipping, reprojection, topology engine, zonal statistics, model training, or production deployment is added here. Before a downloader is implemented, validate the official WaPOR v3 download URL semantics and host allowlist; reject redirects and arbitrary URLs, and enforce byte, time, area, and pixel bounds.


For AOI-clipped processing, width and height describe the cropped pixel window. Source width and height retain the full source COG dimensions. Pixels inside the crop but outside the polygon are counted separately from provider NoData pixels; the three counts must sum to the crop-window pixel count.


The AOI COG runner also records the source sample dtype and provider NoData sentinel in the manifest. These describe how the raw pixel values were represented and which values were excluded; they do not imply a calibration or a verified physical unit.
