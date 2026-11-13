# NOVA Core source-to-sensor identity registry

## Purpose
Observation ingestion currently stores a source ID, optional asset ID, metric, unit and timestamp. It does not store a sensor ID. This registry provides an explicit, tenant/site/asset-scoped bridge between an ingestion source and a physical sensor identity. It deliberately does not assume that a source ID is a sensor ID.

## Lifecycle
- Tenant owner/admin registers an immutable mapping with source, sensor, asset, parameter, unit, effective interval, method and evidence reference.
- A separately assigned active tenant member reviews the mapping. The registrant cannot review their own mapping.
- Review decisions are append-only: verified, rejected, or revoked after verification.
- Resolution for an observation requires exact tenant, site, asset, source, metric/parameter and unit equality, observation timestamp inside the mapping interval, and latest event status verified.
- Zero or multiple matching verified mappings resolve to no sensor identity. No fuzzy matching, parameter aliasing, unit conversion or inference is performed.

## Limits
A verified mapping means a human reviewer approved the declared identity relationship and its cited evidence. It does not prove that the sensor is physically installed, correctly wired, correctly configured, calibrated, accurate or currently communicating. It does not change the observation record or upgrade its verification state. Quality assessment remains blocked until the mapping, calibration, and an explicitly approved tenant-scoped quality policy all match.
