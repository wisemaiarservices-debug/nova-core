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
