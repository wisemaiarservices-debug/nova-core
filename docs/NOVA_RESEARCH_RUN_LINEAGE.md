# NOVA research run lineage contract

## Purpose

This offline contract joins three already-defined pieces without creating a pilot site:

1. A caller-supplied WGS84 GeoJSON Polygon or MultiPolygon, structurally validated by the research AOI validator.
2. A WaPOR `RasterProcessingManifest` that records provider period, dataset/version, processed-window checksum, AOI checksum/bounds, method and code commit.
3. An experiment identifier and a checksum-bound raster input reference compatible with the NOVA experiment registry.

The canonical AOI checksum uses sorted-key compact JSON, matching the research runner. A lineage record is rejected if the exact geometry hash or derived bounding box differs from the raster manifest. Its stable run ID is derived from experiment identity, AOI hash, manifest ID, processed-window hash and processing commit.

## Evidence and identity safeguards

- Evidence remains `satellite_derived`; this is not a field observation.
- `site_id` is fixed to null. Research geometry is not a registered customer site or approved pilot.
- The emitted raster input reference carries the manifest ID, dataset ID, processed-window SHA-256 and optional complete source-object SHA-256.
- The source-object checksum remains absent when the runner did not download and hash the complete source COG.
- This contract checks internal consistency only. It does not retrieve manifests from storage, verify external object bytes, prove provider accuracy, validate polygon topology, or establish scientific skill.

## Experiment registry hand-off

Use `attach_lineage_to_experiment(experiment_manifest, lineage)` to create a revalidated copy of the caller's experiment-manifest type with the exact raster reference appended. It checks dataset ID/version and evidence class, rejects duplicate manifest references, and leaves the original experiment object unchanged. The experiment registry's `resolve_raster_input_manifests` must still receive the corresponding processing-manifest records and validate dataset/version, checksum, evidence class and null site identity. The experiment caller remains responsible for dataset snapshot integrity, train/validation/test split design, leakage prevention and honest evaluation metrics.

## Status

Schema and synthetic unit tests only. No live WaPOR extraction, AOI selection, persistent storage, D1, model training, scientific validation, deployment or production operation is performed by this contract.
