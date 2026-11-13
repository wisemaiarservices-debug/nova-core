# Consolidated irrigation evidence assessment

`assessConsolidatedIrrigationEvidence(payload, { rootDepthObservationIds })` combines existing evidence for each irrigation zone: geometric soil-sample relationships, explicitly selected crop root-depth calculations, declared water-source flow, water-quality sample provenance, and evidence references.

## Interpretation boundaries

- Root-zone available water is calculated only when a caller explicitly selects a root-depth observation and the soil hydraulic measurements cover the full root depth in exact contiguous layers.
- Declared zone design flow is compared only with declared source available flow, both in m³/hour. This is a limited rating comparison, not a network hydraulic analysis or simultaneous multi-zone demand assessment.
- Permitted abstraction in m³/day is reported as declared. The assessment does not convert it to hourly supply because pumping hours, allocation schedules, and actual abstraction are not established.
- Water-quality records preserve parameter, value, unit, timestamp, method, laboratory, and evidence reference. No threshold or suitability interpretation is applied.
- Spatial sample inclusion remains a geometry relationship, not proof of sample representativeness.

Missing, ambiguous, or unresolved evidence remains unassessed. The report does not calculate crop demand, irrigation timing or application amount, water rights compliance, water quality suitability, pump head, pressure losses, hydraulic adequacy, energy autonomy, or operational approval. Engineering and agronomic review remain separate human gates.
