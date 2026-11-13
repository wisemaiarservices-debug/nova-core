# NOVA Core sensor calibration verification

Calibration registrations remain immutable source records. Verification is an append-only event ledger; the effective status is derived from the latest event and is never client-set on the calibration row.

## Governance
Tenant owners/admins may assign or revoke a reviewer for a specific site. The reviewer must be an active tenant member. The decision actor is taken from the verified Access identity forwarded by the gateway. A calibration submitter cannot review their own record. Assignment, revocation and decisions preserve actor, evidence reference, request ID and timestamp.

## Decisions
- `registered_unverified`: no decision event exists.
- `verified`: an independent active reviewer verified the record.
- `rejected`: an independent reviewer rejected the record with a reason.
- `revoked`: a previously verified decision was revoked with a reason.

A verification event requires an evidence reference. If the calibration registration links a laboratory report, verification is blocked until that report has separately reached `verified`. A document digest alone is not scientific or metrological validation.

## Limits
This workflow verifies a calibration record's review state, not the measurement quality of observations. It does not establish traceability, accreditation, calibration uncertainty adequacy, sensor installation identity, drift, conformity or correction factors. No universal tolerance is assumed. Observation quality must remain `not_assessed` until a separate assessment checks exact tenant/site/asset/sensor identity, parameter and unit, observation time against the verified calibration interval, and an explicit reviewed tolerance policy. Revoking a calibration does not retroactively change observation records.
