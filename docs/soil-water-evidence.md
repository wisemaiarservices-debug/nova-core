# Soil-water evidence and available-water calculation

Soil profiles may carry `hydraulic_measurements` records for `field_capacity`, `wilting_point`, and `bulk_density`. Each record is scoped to an explicit profile depth interval and preserves its value, unit, source type (`measured`, `laboratory`, or `modelled`), method, timezone-qualified timestamp, and evidence reference. Missing provenance remains a verification gate.

Irrigation zones may reference `soil_profile_id` and `soil_horizon_id`. These are stable references only; they do not assert that the linked profile represents the entire zone.

`calculatePlantAvailableWater(profile, { top_depth_cm, bottom_depth_cm })` is a deterministic calculation:
- Volumetric inputs: `(field capacity - wilting point) × layer depth`, converted to millimetres.
- Gravimetric inputs: both water contents are converted using one matching, same-depth bulk-density measurement; density units are explicitly converted to kg/m³.
- Inputs must have exactly matching depth intervals. Mixed bases, missing or ambiguous measurements, nonphysical values, and unsupported units return `status: insufficient_inputs`.

This function does not estimate missing soil properties, interpolate between layers, infer spatial representativeness, determine root-zone depth, calculate crop demand, schedule irrigation, or recommend an irrigation amount. The calculation is not an operational or agronomic approval. Model-derived values remain labelled as modelled and require independent validation before use.
