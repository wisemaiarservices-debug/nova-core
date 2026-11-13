# NOVA configuration write contract — v1

This module is a pure validation boundary for the future private tenant configuration write endpoint. It does not perform HTTP, authentication, authorization, D1 writes, or operational activation.

## Required order in the future handler

1. Verify the gateway HMAC envelope and freshness; consume its nonce exactly once.
2. Resolve exactly one active tenant membership for the verified subject.
3. Check the exact tenant/site `create` grant and role ceiling before reading or writing configuration data.
4. Parse a bounded JSON request body; reject unknown top-level request fields.
5. Validate the versioned schema ID against a server-owned allowlist.
6. Canonicalize the JSON object, enforce byte/depth/node/array bounds, and compute SHA-256 on the server.
7. In one D1 batch/transaction, reserve the idempotency key, insert the immutable snapshot, and append the audit event.
8. Return the existing result for an exact idempotent retry; reject reuse of the same key with a different canonical digest.

## Module guarantees

- Deterministic key ordering and JSON serialization.
- Root must be a plain JSON object.
- Rejects non-finite numbers, runtime objects, forbidden prototype keys, excessive nesting, arrays, node count, and encoded size.
- Computes SHA-256 using Web Crypto; caller-supplied digest is optional and, when present, must match the server-computed digest.
- The schema ID must exactly match the server-provided expected ID.

## Explicit non-guarantees

- This module does not authenticate a caller or grant tenant/site access.
- A digest proves content consistency, not truth, source provenance, calibration, scientific validity, or site suitability.
- No write route is exposed and no D1 binding or migration is applied remotely.
- Review approval remains separate from equipment activation or autonomous control.

## Exact authorization decision helper

`apps/tenant-api/src/configuration-write-authorization.mjs` provides a pure fail-closed decision function for a future handler. It requires exactly one active membership for the verified principal and exactly one exact site-level `create` grant. The tenant role must independently permit `create`. Wildcard grants, duplicate grants, cross-tenant rows, inactive memberships, and roles without create authority are denied. The function is not an identity verifier and must receive membership/grant rows from parameterized D1 queries after gateway envelope verification.


The completed idempotent response includes the immutable configuration version as well as the configuration ID, site, schema, digest, request ID and creation timestamp. The idempotency completion update reads these values back from the inserted immutable snapshot within the same D1 batch.

## Persistence completion invariant

Migration 0006 enforces that pending idempotency rows have no response body and completed rows must have a valid non-null response body. The D1 batch helper also requires each of its five statements to report exactly one changed row; a successful SQL execution that silently updates zero rows is treated as a failed write. CI's ordered local D1 migration gate validates the migration syntax and the query-preparation gate validates the statements.

The persistence service now owns the supported schema allowlist internally (`nova.client-config.v1`); callers cannot supply the expected schema ID. Requests naming any other schema are rejected before a write batch is attempted.


## Local D1 persistence integration

The disposable CI-only Wrangler configuration points to `src/local-write-test-entry.mjs`, not the production Worker entrypoint. That test harness invokes the same `createSiteConfiguration()` helper against local D1 and is excluded from the production Wrangler configuration. The local integration verifies sequential versions, exact replay, conflicting idempotency-key reuse, matching review/audit records, and rollback after a deliberately injected late audit-statement failure. The fixture grant is exact to the CI tenant and site; no production identity or data is used.


## Adaptive domain envelope

Before canonicalization and the atomic D1 batch, the write helper now calls
`assessDomainConfiguration()` from
`apps/tenant-api/src/configuration-domain-validation.mjs`. The accepted
`nova.client-config.v1` payload is an envelope with tenant and site identity,
optional multi-valued crop/irrigation/energy profiles, equipment/sensor/gateway
declarations, calibration records, evidence references and namespaced client
extensions. The payload tenant/site IDs must exactly match the separately
authorized tenant/site request context.

Known structural errors reject the write before any idempotency or snapshot
record is created. Missing specifications are reported as readiness issues,
not defaulted or inferred. Unknown fields are flagged; namespaced extensions
are preserved but require client-schema review. Calibration is scoped to
customer site/asset/sensor and cannot represent global model parameters.

The validator returns four independent states: structural validity, evidence
readiness, operational review and model applicability. It never marks
operational review approved and never assesses model applicability. Presence
of an evidence reference, equipment declaration or protocol does not establish
its truth, commissioning, calibration validity, live connectivity or telemetry.

The validator deliberately does not claim full GIS topology/CRS transformation,
engineering sizing, hydraulic/electrical compatibility, device commissioning,
certificate verification or scientific model validity. These remain separate
review gates. Node tests cover multi-system profiles, missing values, explicit
CRS, geometry/range/date errors, tenant/site binding, client extensions,
calibration scope and evidence gaps. The disposable local D1 integration also
proves a structurally invalid configuration creates no idempotency, snapshot,
review or audit rows.


The validator also flags unsupported nested crop, irrigation, energy, equipment, sensor, gateway, calibration and evidence fields. Known numeric engineering ratings (declared irrigation design flow and electrical/energy capacities) must be finite positive values when supplied. These are schema-level sanity checks only: they do not establish hydraulic adequacy, electrical compatibility, equipment sizing, or commissioning.


## Declared equipment relationship checks

The domain validator resolves irrigation `controller_id` values only against
declared equipment IDs, sensor `gateway_id` values only against declared
gateway IDs, and sensor calibration scopes only against sensor IDs. Unresolved
references are readiness issues requiring verification; they are not silently
accepted as confirmed physical connections.

Gateway records may optionally declare `supported_protocols`. When a sensor
references that gateway and both declare a recognized protocol, a protocol not
listed in the gateway capability declaration is flagged for review. Missing
gateway capability declarations are reported as unknown, not treated as
compatible. Malformed or duplicate capability lists are rejected.

These checks compare configuration declarations only. They do not establish
that devices are powered, paired, reachable, commissioned, correctly wired, or
currently exchanging telemetry. A protocol match is not proof of operational
connectivity or end-to-end interoperability.


## Declared energy equipment checks

Energy system profiles may reference declared inverter, battery and PV equipment
IDs. References must resolve to inventory equipment; when an equipment
`asset_class` is supplied, it is compared with the requested role. Missing
equipment references and role mismatches are flagged for review.

Equipment may optionally declare positive finite `rated_voltage_v` and
`rated_power_kw`, plus a declared phase. Energy profiles may declare nominal
voltage and grid phase. Where both sides provide comparable inverter voltage
or phase declarations, mismatches are flagged. Invalid ratings and unsupported
phase labels are rejected.

These checks are deliberately limited to explicit declarations. They do not
calculate electrical design, AC/DC conversion, battery/inverter power flow,
short-circuit ratings, protection coordination, conductor sizing, grid-code
compliance, PV string limits, or system safety. A matching voltage or phase
label is not an engineering approval; qualified review and manufacturer
documentation remain necessary.


## Declared irrigation equipment and zone checks

Irrigation profiles may reference controller and pump equipment IDs. When the
equipment declares an `asset_class`, the validator checks the requested role.
A declared controller protocol can be compared with the irrigation system's
declared control protocol. A declared pump flow rating can be compared with
the system's declared design flow; a requested flow above that rating is
flagged for review.

Optional irrigation zones require unique IDs. Zone-level pump/controller
references are resolved against equipment, with system-level references used
only when a zone does not override them. Positive zone flow and area values
are checked, and a declared zone flow above the system flow is flagged.

These checks are configuration consistency checks, not hydraulic engineering.
They do not calculate total dynamic head, pressure losses, pump curves, pipe
diameters, emitter uniformity, simultaneous zone demand, water quality,
controller I/O capacity, valve sizing or field commissioning. Missing pump
curves, head data, zone topology or manufacturer evidence remain unresolved;
no operational suitability is inferred.


## Calibration certificate traceability and expiry

Calibration records may declare a certificate number, issuing organization and
issue date in addition to their customer/site/asset/sensor scope, unit, method,
effective interval and evidence reference. Missing certificate identity,
issuer or issue date is surfaced as a verification issue; it does not cause
the validator to invent or infer those values.

When the referenced evidence record is present, its source class must be
`calibration_certificate`. If both the calibration record and evidence record
declare an issuer, they must match. Effective intervals are assessed against
an injectable assessment date (UTC calendar date by default): future-effective
and expired records are flagged, as are issue dates in the future or later
than the stated effective start.

An expired or incomplete certificate remains a structurally parseable record
but is not considered evidence-ready. These checks do not authenticate the
issuer, verify a laboratory's accreditation, validate a certificate signature
or digest against an external authority, establish measurement uncertainty or
traceability to national standards, or approve a sensor for operational use.
Certificate and calibration acceptance remain a human verification gate.


## Declared PV string and inverter operating-envelope checks

Energy profiles may declare PV strings with a stable string ID, module count
per series string, parallel string count, and optional module/inverter equipment
references. System-level PV module and inverter references are used when a
string does not override them. References are resolved against equipment
inventory and declared equipment roles are checked.

PV module equipment may declare open-circuit voltage (Voc), maximum-power
voltage (Vmp), short-circuit current (Isc), maximum-power current (Imp), and
negative Voc/Vmp temperature coefficients in percent per degree Celsius.
Inverter equipment may declare maximum DC input voltage, MPPT minimum/maximum
voltage, maximum operating input current and maximum short-circuit current.
When the required values and site design minimum/maximum temperatures are
present, the validator performs bounded first-order temperature-adjusted
checks for cold-string Voc, hot-string Vmp and parallel-string operating and
short-circuit current against the declared inverter limits. Missing inputs
remain unknown; no standard module or climate assumptions are substituted.

These calculations are screening checks based on declared nameplate values
and linear temperature coefficients. They do not replace manufacturer design
tools or electrical engineering. They do not evaluate module bin tolerances,
irradiance-dependent current, bifacial gain, voltage transients, altitude,
cable voltage drop, connector compatibility, string fusing, MPPT allocation,
unequal string lengths, shading, degradation, code requirements or protection
coordination. A passing result is not a design approval or safety certification.
