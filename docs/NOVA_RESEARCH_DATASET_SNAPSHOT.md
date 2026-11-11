# NOVA research dataset snapshot fingerprint

## Purpose

A research run needs a deterministic identity for the exact input data and processing chain. `ResearchDatasetSnapshot` derives that identity from a validated `ResearchRunLineage` and its `RasterProcessingManifest`.

The snapshot includes dataset ID/version, provider, mapset/raster code, provider period, exact AOI checksum, processed-window checksum, optional complete source-object checksum, provider metadata checksum, processing commit/method, window dimensions, pixel accounting and explicit units when available.

## Hash semantics

`snapshot_sha256` is SHA-256 over canonical sorted-key compact JSON of the immutable snapshot fields. Retrieval timestamps and mutable download URLs are excluded so that a repeated retrieval of the same source and processing result has the same identity. Any change to the processed pixels, AOI, provider metadata, processing commit, dimensions or pixel accounting changes the fingerprint.

The optional `source_object_sha256` remains null when the full source COG was not downloaded and hashed. The processed-window hash is not represented as a full source-object checksum.

## Experiment registry hand-off

Set `ExperimentManifest.dataset_snapshot_sha256` to `snapshot.snapshot_sha256`, and its dataset ID/version/evidence class to the matching snapshot values. Attach the research raster reference through `attach_lineage_to_experiment`. This allows the experiment manifest to identify both the complete research snapshot and the exact raster window reference.

## Evidence limits

The snapshot proves deterministic identity of the declared inputs and metadata only. It does not prove source authenticity, field truth, scientific accuracy, model skill, or storage integrity. WaPOR remains satellite-derived evidence; `site_id` remains null. No live retrieval, AOI selection, persistence, training, or deployment is performed.
