# Soil-water evidence and available-water calculation

Soil profiles may carry `hydraulic_measurements` records for `field_capacity`, `wilting_point`, and `bulk_density`. Each record is scoped to an explicit profile depth interval and preserves its value, unit, source type (`measured`, `laboratory`, or `modelled`), method, timezone-qualified timestamp, and evidence reference. Missing provenance remains a verification gate.

Irrigation zones may reference `soil_profile_id` and `soil_horizon_id`. These are stable references only; they do not assert that the linked profile represents the entire zone.

`calculatePlantAvailableWater(profile, { top_depth_cm, bottom_depth_cm })` is a deterministic calculation:
- Volumetric inputs: `(field capacity - wilting point) × layer depth`, converted to millimetres.
- Gravimetric inputs: both water contents are converted using one matching, same-depth bulk-density measurement; density units are explicitly converted to kg/m³.
- Inputs must have exactly matching depth intervals. Mixed bases, missing or ambiguous measurements, nonphysical values, and unsupported units return `status: insufficient_inputs`.

This function does not estimate missing soil properties, interpolate between layers, infer spatial representativeness, determine root-zone depth, calculate crop demand, schedule irrigation, or recommend an irrigation amount. The calculation is not an operational or agronomic approval. Model-derived values remain labelled as modelled and require independent validation before use.


## Crop root-depth evidence and root-zone aggregation

Crop records may carry `root_depth_observations`. Each observation records a positive root depth in centimetres, growth stage, source type (`measured`, `laboratory`, or `modelled`), method, timezone-qualified observation timestamp, and evidence reference. Multiple observations are retained rather than silently choosing the newest. Root-zone calculations require an explicit `observation_id`.

Irrigation zones may declare `crop_ids`; unresolved crop references are surfaced for verification. This is a relationship only and does not assert that the crop is present, healthy, or uniformly distributed throughout the zone.

`calculateRootZoneAvailableWater(profile, crop, { observation_id })` aggregates the existing layer calculation only when soil hydraulic measurements form contiguous, exact depth intervals from zero to the selected observed root depth. Gaps, overlaps, ambiguous measurements, incompatible units, missing hydraulic properties, or a layer extending beyond the observed root depth do not get interpolated or prorated; the result is `status: insufficient_inputs`.

This remains an evidence-gated physical calculation. It does not estimate root depth, infer root distribution, determine crop water demand, account for salinity or stress, select depletion fractions, schedule irrigation, or issue a crop-specific irrigation recommendation. Spatial representativeness between samples and irrigation-zone boundaries is not established by these identifiers.
