# NOVA model applicability and abstention contract v1

The applicability service compares a versioned model's declared operating envelope with a supplied client/site capability context. It is a guardrail, not an ML model and not evidence that a model generalizes.

## Scope dimensions

- Domain (agriculture, water, energy, solar, infrastructure, climate).
- Crop species, with explicit restricted/unrestricted/unknown scope.
- Climate zone, with explicit restricted/unrestricted/unknown scope.
- Equipment classes, with explicit restricted/not-required/unknown scope.
- Optional minimum/maximum land area in canonical square metres.
- Required feature metrics, accepted units and accepted evidence classes.
- Model lifecycle and independent validation report reference.

## Decision states

- `not_applicable`: a hard scope mismatch; abstain.
- `needs_configuration`: applicability or input units/evidence are unknown/incompatible; abstain.
- `insufficient_data`: one or more required features are absent; abstain.
- `research_only`: scope matches but the model is not independently validated.
- `applicable_for_review`: declared scope and input checks pass and independent validation is referenced; still requires human review.

No state authorizes autonomous control. A referenced validation report is a required pointer, not cryptographic proof that its contents are valid.

## Cross-client generalization

A model validated for one crop, climate, area range, sensor family or equipment class is not presumed valid elsewhere. Independent evaluation should include geographic/client holdouts, temporal holdouts, different seasons, sensor calibration and data quality strata, baseline comparisons, error/bias, calibration and drift checks. Customer-specific calibration and global model versions must remain distinguishable.

## Not implemented

No training, model inference, feature extraction, automatic model selection, validation report verification, telemetry ingestion, persistence, deployment or control is implemented. This service only performs declared-scope checks on caller-supplied metadata.
