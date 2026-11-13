# NOVA client onboarding readiness v1

## Purpose
Provide a deterministic, side-effect-free readiness assessment from the existing
versioned client/site configuration and tenant/site capability inventory.

## Result states
- `needs_information`: required profile or inventory information is absent.
- `needs_verification`: declared values exist but evidence such as calibration,
  equipment rating provenance, or authenticated connectivity is not verified.
- `ready_for_review`: supplied configuration and verification checks pass.
  This is not operational approval, model validation, or authorization for
  autonomous control.

## Checks
Site profile: land area and unit, boundary, crop profiles, irrigation, energy.
Equipment: manufacturer/model, protocol, engineering ratings and rating source.
Sensors: identity, protocol, connectivity verification, calibration status and
independent certificate reference.

## Trust boundaries
- Missing values remain missing; no defaults or customer facts are fabricated.
- Sensor measurement capabilities are declarations, not observations.
- A sensor marked connected is not accepted as verified unless the registry
  explicitly carries the verified state; this service does not perform the
  live check itself.
- A calibration is accepted as verified only when status is current,
  independently_verified is true, and a certificate reference is present.
- `ready_for_review` is a data-readiness label only. Human review, tenant
  authorization, ingestion controls, scientific validation and site safety
  review remain separate gates.
- This service does not persist records, create tenants, authenticate users,
  access D1, discover devices, call external providers, or control equipment.
