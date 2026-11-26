# NOVA research run lineage contract

## Purpose

This offline contract joins a caller-supplied WGS84 GeoJSON AOI, a WaPOR `RasterProcessingManifest`, and an experiment identity into a deterministic research-run lineage.

The canonical AOI checksum uses sorted-key compact JSON, matching the research runner. A lineage record is rejected if the exact geometry hash or derived bounding box differs from the raster manifest. Its stable run ID is derived from experiment identity, AOI hash, manifest ID, processed-window hash and processing commit.

## Evidence and identity safeguards

- Evidence remains `satellite_derived`; this is not a field observation.
- `site_id` is fixed to null. Research geometry is not a registered customer site or approved pilot.
- The emitted raster input reference carries manifest ID, dataset ID, processed-window SHA-256 and optional complete source-object SHA-256.
- The source-object checksum remains absent when the runner did not download and hash the complete source COG.
- The contract checks internal consistency only; it does not verify external object bytes, provider accuracy or scientific skill.

## Experiment registry hand-off

`attach_lineage_to_experiment` requires the exact experiment ID, dataset ID/version, snapshot fingerprint and evidence class. It rejects duplicate manifest references and returns a revalidated copy without mutating the original experiment. The experiment registry must still resolve the corresponding processing-manifest records and validate dataset/version, checksums, evidence class and null site identity.

## Status

Schema and synthetic unit tests only. No live WaPOR extraction, AOI selection, persistent storage, D1, model training, scientific validation, deployment or production operation is performed.
