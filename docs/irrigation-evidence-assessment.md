# Consolidated irrigation evidence assessment

`buildIrrigationEvidenceAssessment(payload, { irrigation_system_id, zone_id, root_depth_observation_ids })` assembles existing tenant/site-scoped records for one explicitly selected irrigation zone.

The report links:
- The irrigation system's explicitly referenced water source, declared available flow and permitted daily abstraction.
- Water-quality sample counts and provenance completeness, without interpreting chemical or microbiological suitability.
- The zone's explicitly linked soil profile and geometric sample-to-zone relationships.
- Root-zone available-water calculations only for crops linked to the zone and only when a caller explicitly selects a root-depth observation for each crop.

A simple flow comparison is reported only when both declared values exist in the same unit (m³/hour). A source declaration below a system design-flow declaration is a configuration conflict to investigate, not proof of actual shortage. A higher declaration is not proof of adequate yield, pressure, runtime, seasonal availability or sustainable abstraction.

Missing or ambiguous links remain unresolved. The report does not estimate missing values, interpret water-quality thresholds, convert daily abstraction limits into hourly supply, infer crop demand, or treat point-in-polygon inclusion as sample representativeness. Root-zone available water remains a deterministic calculation from supplied evidence, not a crop-water requirement.

The report's operational decision is always `not_authorized` and model applicability remains `not_assessed`. It is not a hydraulic network design, water-rights assessment, agronomic recommendation, irrigation schedule, safety approval or commissioning record. Qualified human review and applicable local regulatory checks remain necessary.
