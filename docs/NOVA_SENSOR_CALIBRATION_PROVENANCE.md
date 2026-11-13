# NOVA Core sensor calibration provenance

## Scope
This change registers calibration records against an existing tenant, site, asset and sensor identifier. It preserves parameter, explicit unit, method, calibration timestamp, validity end, declared laboratory, optional numeric reference/as-found/as-left values, uncertainty, notes and an optional same-site laboratory-report evidence reference.

All records are created as `registered_unverified`; measurement quality remains `not_assessed`. The client cannot set verification status. Registration is append-only and accompanied by an immutable event. Records cannot be updated or deleted through SQL.

## Evidence and interpretation limits
A calibration record is a declaration with provenance, not proof of metrological traceability, laboratory accreditation, certificate authenticity, sensor installation identity, field condition, calibration quality or continued sensor performance. A linked laboratory PDF remains `registered_unverified`; the link does not upgrade either record.

The service validates structure, numeric finiteness, non-negative declared uncertainty, timezone-qualified timestamps and a positive validity interval. It does not calculate calibration residuals, uncertainty budgets, drift, conformity, measurement correction or a universal tolerance. It does not retroactively certify observations.

## Next governed stage
A separate human-verification workflow must validate the calibration evidence and reviewer authority before any observation can be assessed against calibration validity. Measurement-quality assessment must also require exact tenant/site/asset/sensor identity, matching parameter and unit, observation timestamp within the verified calibration interval, and explicit tolerance/uncertainty policy. Missing or conflicting inputs remain `not_assessed`; no default tolerance or inferred calibration is allowed.
