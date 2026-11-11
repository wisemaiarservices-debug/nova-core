# NOVA unified client capability assessment v1

## Purpose
Compose the versioned client/site configuration, tenant/site-scoped capability
inventory, and evidence-gated model applicability contracts into one
side-effect-free assessment. This is the first integration seam for adaptive
NOVA Core behaviour across NeoAgro, NeoGrid, NeoCell and NOVA OS.

## Data flow
1. Caller supplies a validated `ClientConfiguration`.
2. Caller supplies a matching `CapabilityRegistry`.
3. The adapter verifies tenant and site identifiers match exactly.
4. It derives land area in square metres from the declared unit.
5. It derives a crop species only when all configured crop profiles agree.
   Mixed-crop sites remain ambiguous rather than selecting the first crop.
6. Equipment classes are derived from declared inventory.
7. Sensor capabilities are reported as declarations, never promoted into
   observed model features.
8. Only separately supplied `AvailableFeature` records with explicit
   evidence classes are passed to model applicability assessment.
9. The existing applicability gate returns abstain, research-only, or
   human-review-only. It never enables autonomous control.

## Boundaries
- In-memory only; no API route, persistence, D1, tenant authorization/RLS,
  device discovery, telemetry, inference, or model training.
- Caller-supplied feature provenance is not independently verified here.
- Declared sensor range, unit, cadence, calibration, and protocol do not prove
  installation, calibration, accuracy, or connectivity.
- Climate classification remains caller-supplied and is not inferred from
  coordinates.
- Model scope checks do not establish scientific validity or cross-client
  generalization.
