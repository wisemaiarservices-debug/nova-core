# NOVA experiment registry and evaluation contract

**Status:** offline metadata and metric primitives; no model training, dataset loading, experiment persistence, or deployment approval is implemented.

## Purpose

The experiment manifest makes a research result reproducible by recording:

- stable experiment ID, domain, task, target, unit and forecast horizon;
- dataset ID/version and SHA-256 hash of the exact immutable dataset snapshot (or a documented manifest for a non-redistributable source);
- evidence class, geography and temporal resolution;
- explicit feature names;
- chronological train, validation and untouched test windows;
- exact 40-character source-code commit and model version;
- optional random seed and model-artifact hash;
- holdout metrics and a separate baseline comparison.

Manifests are immutable Pydantic models. They are not written to D1 or another database by this PR. No experiment record is automatically created from a connector response.

## Split rules

All split boundaries must be timezone-aware. Windows use half-open semantics: `[start, end)`. The training window must end no later than validation begins, and validation must end no later than the untouched test window begins. The experiment owner must still verify that feature construction, labels, rolling windows, revisions and preprocessing do not leak information across these boundaries.

A chronological split is not a substitute for a geographic/site holdout when cross-location generalization is claimed.

## Regression evaluation

`evaluate_regression` accepts paired actual, model prediction and baseline prediction sequences and returns:

- sample count;
- mean absolute error (MAE);
- root mean squared error (RMSE);
- mean signed error (prediction minus actual);
- baseline MAE and RMSE;
- RMSE skill score: `1 - model_RMSE / baseline_RMSE`.

A positive skill score means the model RMSE is lower than the supplied baseline RMSE; zero means equal RMSE; a negative value means the model is worse. If the baseline RMSE is zero, skill is undefined and returned as `null`, not infinity.

The evaluator rejects empty, non-numeric, non-finite, unpaired and single-sample inputs. It does not verify that arrays are genuinely held out, that baseline selection avoided leakage, that units match, or that observations are trustworthy. Those remain experiment-owner responsibilities and must be documented with the dataset snapshot and evidence class.

## Evidence and release semantics

- `research`: a reproducible experiment description; no predictive-performance claim is implied.
- `evaluated`: manifest includes holdout metrics within its declared test window. This is a metadata gate, not an independent scientific audit or production approval.

Test fixtures use `synthetic_test_fixture` where appropriate and are never evidence of field performance. No metric generated from a synthetic fixture may be represented as a real-world validation result.

Operational release still requires an untouched evaluation period, relevant geographic holdouts, baseline comparisons, subgroup/seasonal analysis, uncertainty/calibration where applicable, documented limitations and human review. Infrastructure recommendations remain advisory; no autonomous actuation is supported.

## API and storage status

This module is currently an internal Python service library only. It adds no public endpoint, database table, D1 binding, file upload, model artifact store, job queue, credentials or background training. A future persistent registry requires explicit storage, retention, identity, access-control and billing review first.
