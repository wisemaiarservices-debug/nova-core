# NOVA research dataset snapshot fingerprint

## Purpose

A research run needs a deterministic identity for the exact data window and its scientific interpretation. `ResearchDatasetSnapshot` derives that identity from a validated `ResearchRunLineage` and `RasterProcessingManifest`.

The fingerprint includes dataset/provider/version, mapset/raster and period, exact AOI hash and bounds, processed-window hash, optional complete source-object hash, provider metadata hash, processing commit/method, source and window dimensions, source dtype and NoData sentinel, pixel accounting, raw and calibrated statistics, units, CRS and affine transform.

## Hash semantics

`snapshot_sha256` is SHA-256 over canonical sorted-key compact JSON of the immutable snapshot fields. Retrieval timestamps and mutable download URLs are excluded. A change in pixels, AOI, provider metadata, source dtype/NoData, calibration, units, spatial interpretation, dimensions, processing commit or pixel accounting changes the fingerprint.

The optional `source_object_sha256` remains null when the full source COG was not downloaded and hashed. The processed-window hash is not represented as a full source-object checksum.

The snapshot model independently validates window limits, pixel-count reconciliation, paired source dimensions, raw-statistic completeness, calibration consistency, finite spatial metadata and WGS84 AOI bounds.

## Experiment registry hand-off

Set `ExperimentManifest.dataset_snapshot_sha256` to `snapshot.snapshot_sha256`, and its dataset ID/version/evidence class to the matching snapshot values. `attach_lineage_to_experiment` checks that fingerprint and the exact experiment ID before appending the raster reference. It returns a revalidated copy and leaves the original experiment unchanged.

## Evidence limits

The snapshot proves deterministic identity of declared inputs and interpretation metadata only. It does not prove source authenticity, field truth, scientific accuracy, model skill or storage integrity. WaPOR remains satellite-derived evidence; `site_id` remains null. No live retrieval, persistence, training or deployment is performed.
