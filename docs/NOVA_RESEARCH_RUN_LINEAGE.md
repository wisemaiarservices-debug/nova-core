# NOVA research run lineage contract

## Purpose

This offline contract joins three already-validated objects:

1. A caller-supplied WGS84 GeoJSON Polygon or MultiPolygon.
2. A bounded FAO WaPOR COG `RasterProcessingManifest` with exact AOI hash/bounds, provider period, processed-window checksum, pixel accounting, source dtype/NoData, CRS/transform and processing commit.
3. A validated NOVA `ExperimentManifest` whose dataset snapshot fingerprint matches the derived `ResearchDatasetSnapshot`.

The canonical AOI checksum uses the shared sorted-key compact JSON helper and the 1 MiB AOI payload limit. A lineage record is rejected if the exact geometry hash or derived bounding box differs from the raster manifest. It only accepts the WaPOR COG AOI processing method, explicit source dtype and provider metadata fingerprint.

## Stable run identity

The run ID is derived from experiment ID, dataset ID/version, provider period, AOI hash, manifest ID, stable provider metadata fingerprint, processed-window checksum, optional full-source checksum, processing commit and method. Retrieval timestamps and mutable download URLs are excluded.

## Evidence and identity safeguards

- Evidence remains `satellite_derived`; this is not a field observation.
- `site_id` is fixed to null. Research geometry is not a registered customer site or approved pilot.
- The emitted raster input reference carries manifest ID, dataset ID, processed-window SHA-256, evidence class and optional complete source-object SHA-256.
- The source-object checksum remains absent when the runner did not download and hash the complete source COG.
- The provider metadata fingerprint includes stable mapset fields (code, caption, unit, description) and raster code/period only; mutable download and gsutil URLs are excluded.
- Lineage construction validates the AOI, raster manifest, AOI hash/bounds and provider/method requirements. It does not retrieve manifests from storage or prove external object authenticity.

## Experiment registry hand-off

`attach_lineage_to_experiment(experiment_manifest, lineage)` accepts the actual validated `ExperimentManifest` type and returns a revalidated copy. It requires matching experiment ID, dataset ID/version, satellite evidence class and exact `dataset_snapshot_sha256`. It rejects existing raster inputs because this adapter binds one raster per snapshot; multi-raster aggregation requires a separate composite snapshot design. The original experiment object is unchanged.

The experiment registry's `resolve_raster_input_manifests` must still receive the corresponding immutable processing-manifest records and validate dataset/version, checksums, evidence class and null site identity. The experiment caller remains responsible for train/validation/test split design, leakage prevention and honest evaluation metrics.

## Status

Schema and synthetic unit tests only. No live WaPOR extraction, AOI selection, persistent storage, D1, model training, scientific validation, deployment or production operation is performed by this contract.
