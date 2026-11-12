# NOVA Core Human Access Identity — Design Gate V1

Status: design decision; implementation and route exposure remain blocked pending a verified runtime boundary.

## Decision

Human authentication for tenant-facing NOVA OS and NOVA Core routes must be performed at a trusted JavaScript Cloudflare Worker edge using the native Web Crypto API (or a separately reviewed, supported JWT library). The current FastAPI/Python API must not decode a token and treat its claims as verified. The existing Python `cloudflare_access_identity.py` is explicitly a claims adapter for service tokens, not a signature verifier and not a human identity adapter.

The existing ingestion Worker's `access-auth.mjs` demonstrates a working RS256/JWKS verification pattern, but it is scoped to service tokens. Do not reuse its service-token identity policy for humans, and do not expose tenant APIs through the ingestion Worker merely to reuse that code. Extract a shared verifier only after its runtime and deployment boundary are chosen and tested.

## Trusted human identity contract

The future verifier must:

1. Read only `Cf-Access-Jwt-Assertion` from the trusted request path. Do not trust `Cf-Access-Authenticated-User-Email`, browser-supplied subject fields, or decoded JWT payloads.
2. Enforce a bounded token size and exactly three JWT segments.
3. Accept only `RS256`; require a non-empty `kid`; resolve the key from the configured team's `/cdn-cgi/access/certs` JWKS; validate RSA signing-key metadata; refresh JWKS once for an unknown key ID; cache keys for a bounded interval; fail closed if key retrieval or signature verification fails.
4. Verify the signature before consuming claims, then require exact configured issuer and application audience, valid integer `exp`, `iat`, optional `nbf`, and sensible time ordering with a small documented clock skew.
5. Require a non-empty, bounded `sub` as the immutable principal subject. Reject service tokens (Cloudflare service-token claims have an empty `sub` and use `common_name`). Do not use email as the database principal key. Email may be retained only as a verified display/audit attribute.
6. Return a minimal immutable principal, e.g. `{ subject, issuer, audience, email? }`. Never accept a principal or verified claims object from request JSON.
7. Map authentication failures to generic 401 responses; map JWKS/provider outages to generic 503 responses. Never return token, signature, key, or provider internals.

## Authorization and request flow

```text
Browser
  -> Cloudflare Access policy
  -> trusted identity-verification edge
  -> verified principal.subject
  -> tenant selector from route (not an entitlement)
  -> D1 membership loader (PR #38)
  -> exact resource/action authorization
  -> tenant-scoped repository (PR #39)
  -> response
```

- Tenant IDs and resource IDs from URLs are selectors only. They do not establish membership or grants.
- Roles and exact resource grants come only from tenant-scoped D1 records and the PR #36 policy.
- The identity adapter must not assign tenant roles from email domains, JWT group claims, client configuration, or UI state.
- Every tenant-facing read must use the authorization-first repository. Future writes require separate authorization-first write services and atomic audit persistence.
- Denied and absent resources should remain indistinguishable to callers.
- Keep the service-token ingestion identity and human-user identity as separate principal types and separate policy paths.

## Runtime/deployment gate

Before implementation, inspect and prove the selected Cloudflare deployment model can preserve the verified principal across the edge-to-API boundary. Prefer a same-Worker internal call or a private service binding. If a signed internal assertion is unavoidable, define its own issuer, audience, short expiry, replay controls, key management, and verification; never forward a browser-provided subject header. The Python API must accept identity only from that authenticated internal boundary.

No tenant routes may be exposed until:
- Access application coverage includes every public hostname and any `workers.dev` hostname; bypass paths are tested.
- issuer and audience are configured per environment without committing secrets;
- human tokens pass and service tokens, forged tokens, wrong-audience tokens, expired tokens, unknown-kid tokens, and JWKS outages fail closed;
- identity is connected to PR #38 membership loading and PR #39 reads;
- D1 migration and binding are reviewed and explicitly provisioned;
- audit behavior, tenant isolation and integration tests pass.

## Required tests

- valid human token resolves the exact `sub` and optional email;
- empty/missing `sub` and service-token `common_name` are rejected;
- malformed/oversized JWT, non-RS256 algorithm, missing `kid`, invalid signature, wrong issuer/audience, expired token, future `iat`, and invalid `nbf` are rejected;
- unknown `kid` triggers one JWKS refresh; unavailable/invalid JWKS fails closed;
- untrusted email and identity headers do not influence the principal;
- browser-supplied tenant ID cannot grant access without the exact D1 membership and resource grant;
- no route accepts caller-supplied `principal_subject` or authorization records.

## Current implementation facts

- PR #36 supplies tenant policy and D1 schema primitives; its migration has not been applied.
- PR #38 loads trusted membership and exact grants from D1; it does not authenticate users.
- PR #39 supplies authorization-first, tenant-scoped reads; it does not authenticate users or expose routes.
- The ingestion Worker verifies RS256 service-token JWTs using Web Crypto and a JWKS cache. Its policy requires service-token claims and must not be treated as human-user verification.
- No D1 database, binding, tenant, membership, customer record, Access application, or human identity route is provisioned by this design.

## References

- Cloudflare Access JWT validation: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- Cloudflare Access signing keys and rotation: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- Existing NOVA Core implementation: `apps/ingestion-worker/src/access-auth.mjs` (service-token verifier only).
