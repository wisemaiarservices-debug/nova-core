# NOVA research dataset snapshot fingerprint

## Purpose

A research run needs a deterministic identity for the exact data and processing inputs. `ResearchDatasetSnapshot` derives that identity from a validated `ResearchRunLineage` and its `RasterProcessingManifest`.

The snapshot includes:

- dataset ID/version, provider, mapset/raster code and provider period;
- exact AOI hash and WGS84 bbox;
- processed-window checksum and optional complete source-object checksum;
- stable provider metadata fingerprint and processing code commit/method;
- processed and source dimensions plus valid/NoData/outside-AOI pixel counts;
- source dtype and NoData sentinel;
- explicit CRS and affine transform;
- raw statistics, optional scale/offset and calibrated statistics;
- authoritative units when available;
- fixed `satellite_derived` evidence class and `site_id: null`.

## Hash semantics

`snapshot_sha256` is SHA-256 over canonical sorted-key compact JSON of every immutable snapshot field. Retrieval timestamps and mutable download URLs are excluded. The provider metadata fingerprint is itself constructed only from stable mapset metadata (code, caption, unit, description) and raster code/period; mutable download and gsutil URLs are not included.

A change to processed pixels/masks/spatial metadata, AOI, source dtype/NoData, provider metadata, processing commit, source-object checksum, dimensions, pixel accounting, calibration or units changes the fingerprint. The optional `source_object_sha256` remains null when the full source COG was not downloaded and hashed. The processed-window hash is not represented as a full source-object checksum.

## Integrity checks

- Pixel counts must sum to processed width × height, with a 10-million-pixel cap.
- Source dimensions must be paired and contain the processed window; a full-source checksum requires source dimensions.
- AOI bbox must be finite, ordered and within WGS84; the AOI hash is mandatory.
- All-NoData windows require null raw statistics.
- Explicit scale/offset must be paired and scaled min/max/mean must match the raw statistics, including negative scale.
- CRS and affine transform must be internally consistent; user-defined GeoTIFF CRS code 32767 is rejected.
- Source dtype/NoData and units cannot be empty or inferred.

## Experiment registry hand-off

Set `ExperimentManifest.dataset_snapshot_sha256` to `snapshot.snapshot_sha256`, and its dataset ID/version/evidence class to the matching snapshot values. Then attach the exact raster input reference through `attach_lineage_to_experiment`. This adapter currently supports one raster per snapshot; multi-raster aggregation needs an explicit composite snapshot contract.

## Evidence limits

The snapshot proves deterministic identity of declared inputs and metadata only. It does not prove source authenticity, field truth, scientific accuracy, model skill, or storage integrity. WaPOR remains satellite-derived evidence; `site_id` remains null. No live retrieval, AOI selection, persistence, training, or deployment is performed.
