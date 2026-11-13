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
