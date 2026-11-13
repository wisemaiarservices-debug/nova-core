# NOVA Core sensor calibration and measurement-quality API

## Register a calibration

POST /api/v1/tenants/{tenant_id}/sites/{site_id}/sources/{source_id}/calibrations

Requires a verified Cloudflare Access identity, active tenant membership, tenant owner/admin role and exact site read grant. The source must belong to the requested tenant/site and the site must be active.

Example body:

    {
      "instrument_serial": "SENSOR-001",
      "metric": "soil_moisture",
      "unit": "%",
      "calibration_method": "laboratory",
      "calibration_standard": "Declared reference standard",
      "calibrated_at": "2026-10-01T10:00:00Z",
      "valid_until": "2027-10-01T10:00:00Z",
      "range_min": 0,
      "range_max": 100,
      "uncertainty": 0.5,
      "evidence_ref": "lab-report:report-id"
    }

Methods are laboratory, field_comparison, manufacturer, reference_instrument or other. Numeric range and uncertainty are expressed in the observation's declared unit; no unit conversion is performed. Dates must be valid RFC3339 instants with timezone. valid_until must be later than calibrated_at. A lab-report evidence reference must resolve to a persisted report for the same tenant/site. Other evidence references are identifiers that a reviewer must independently inspect.

New records are always unverified. The uploader cannot review their own calibration.

## Verify, reject or revoke

POST /api/v1/tenants/{tenant_id}/sites/{site_id}/sources/{source_id}/calibrations/{calibration_id}/review

Requires an active site-scoped measurement_reviewer assignment, active tenant membership and a reviewer distinct from the uploader.

Verify:

    { "decision": "verify", "evidence_ref": "inspection:calibration-review" }

Reject or revoke require a reason:

    { "decision": "reject", "evidence_ref": "inspection:review", "reason": "Certificate does not match the sensor serial" }

    { "decision": "revoke", "evidence_ref": "inspection:withdrawal", "reason": "Calibration certificate withdrawn" }

The decision event and status transition are atomic. Registration, review and revocation events are append-only. Calibration identity, scope, dates, ranges, uncertainty and evidence references are immutable. Rejected records remain rejected; revoked verified records return to unverified and require a new independent review.

## Assess an observation's calibration coverage

GET /api/v1/tenants/{tenant_id}/observations/{observation_id}/measurement-quality

Requires active tenant membership and an exact read grant for the observation's site.

The assessment looks for exactly one verified calibration matching the observation's tenant, site, source, metric and unit, with calibrated_at <= observed_at <= valid_until. It then checks whether the recorded value lies within the declared calibration range.

Possible outcomes:
- covered_by_verified_calibration: one verified calibration covers the observation timestamp and value lies within its declared range.
- not_assessed with calibration_pending_human_review: matching calibration record exists but has not been verified.
- not_assessed with no_verified_calibration_covers_observation_time: no verified calibration covers the observation timestamp.
- not_assessed with multiple_verified_calibrations_cover_observation_time: overlapping verified records are ambiguous.
- not_assessed with observation_outside_verified_calibration_range: the value is outside the declared range.

The result also returns the original ingestion quality flags and observation verification status. Calibration coverage does not verify the observation itself, establish sensor accuracy, quantify total uncertainty, validate calibration method or reference standards, prove traceability, or authorize operational decisions. No automatic correction, interpolation, unit conversion, sensor control or irrigation action occurs.

## Trust limitations

A reviewer decision records a human review of declared calibration information and referenced evidence. It does not authenticate an external certificate, prove laboratory accreditation, establish metrological traceability or independently demonstrate measurement accuracy. The calibration evidence reference must be inspected through a separate governed evidence process.

This API is advisory measurement-quality provenance only. All decisions remain subject to human review. Sensor calibration status is never inferred from source metadata, a quality flag or an unverified calibration record.
