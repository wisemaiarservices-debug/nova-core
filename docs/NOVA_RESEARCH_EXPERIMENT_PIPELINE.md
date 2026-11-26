# NOVA offline research experiment pipeline

## Scope

The pipeline composes four validated artifacts for one research experiment:

1. Caller-supplied WGS84 AOI geometry.
2. One WaPOR COG raster-processing manifest.
3. The immutable dataset snapshot derived from that manifest and AOI.
4. One NOVA `ExperimentManifest`.

Preparation validates experiment ID, dataset ID/version, satellite evidence, exact snapshot hash, AOI/manifest lineage and the full serialized processing manifest. It does not trust a partial checksum match: provider metadata, processing method, period, dimensions, pixel counts, NoData, units, CRS/transform and every other manifest field must match the lineage manifest exactly.

The current adapter supports exactly one raster per snapshot. Multi-raster experiments require a composite snapshot contract before they can be prepared.

## Evaluation

`evaluate_research_experiment` accepts caller-supplied actual, predicted and baseline arrays. It computes MAE, RMSE, mean error and RMSE skill score, then returns a new immutable evaluated bundle. The original research bundle remains unchanged.

Input arrays are capped at one million samples, must have equal lengths, contain at least two finite real numeric values and reject booleans, strings and mappings. Metrics must be finite and their declared test period must fall inside the experiment's chronological test split.

## Scientific and operational limits

- The pipeline does not load observations or verify array timestamps, alignment, units, holdout provenance, geographic independence or baseline selection. The caller must establish these conditions.
- A baseline comparison and valid metrics do not prove scientific validity, generalization, causal effect, forecast skill in deployment, or operational fitness.
- The pipeline does not train a model, choose hyperparameters, create artifacts, persist experiments, access a database, register tenants/sites, or deploy anything.
- WaPOR remains `satellite_derived`, not a field observation; research `site_id` remains null.
- No live provider request or external storage verification occurs during bundle preparation.
