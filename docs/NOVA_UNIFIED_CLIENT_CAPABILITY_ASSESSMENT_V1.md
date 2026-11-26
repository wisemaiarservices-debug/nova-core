# NOVA unified client capability assessment v1

## Purpose
Compose the versioned client/site configuration, bounded tenant/site capability
inventory, explicit unit normalization and evidence-gated model applicability
contracts into one side-effect-free in-memory assessment.

## Data flow
1. Caller supplies a validated `ClientConfiguration` and matching `CapabilityRegistry`.
2. Adapter verifies exact tenant and site identity agreement.
3. Declared land area is converted to square metres through the finite-safe unit registry.
4. A crop species is exposed only when all configured crop profiles agree; mixed crops remain ambiguous.
5. Equipment classes and declared sensor metrics are summarized from the registry.
6. Sensor capabilities remain declarations, never observed features.
7. Only separately supplied `AvailableFeature` records with explicit evidence classes enter the model applicability check.
8. The model applicability gate returns abstain, research-only or human-review-only. It never authorizes autonomous control.

## Boundaries
- The adapter is in-memory only: no API route, persistence, D1, tenant authorization/RLS, device discovery, telemetry, inference, training or actuation.
- Caller-supplied feature provenance is not independently verified.
- Climate zone is caller-supplied; it is not inferred from coordinates.
- Declared sensor range, unit, cadence, calibration and protocol do not prove installation, calibration, accuracy or connectivity.
- Unit conversion preserves explicit dimensions but does not establish physical plausibility or measurement quality.
- A validation report reference is a pointer, not proof of scientific validity or cross-client generalization.
