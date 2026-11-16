# NOVA Core identity-link HTTP routes v1

## Status

This branch introduces the four identity-link routes below. They are not available in production until the draft pull request is reviewed, merged, deployed, and explicitly configured. No production Supabase or Cloudflare values are assumed.

## Challenge ceremony

### Create a challenge

`POST /api/v1/identity-links/challenges`

Requires:
- A valid Cloudflare Access JWT accepted by the gateway.
- A Supabase Auth bearer JWT in `Authorization: Bearer <token>`.
- Both identity providers configured with exact issuer and audience values in the private Worker.

Body must be an empty JSON object. The private Worker validates the signed gateway envelope and forwards the Supabase token to the dual-verification helper. That helper performs the single authoritative Supabase JWT verification for the request while binding the verified Supabase identity to the independently gateway-verified Cloudflare identity. The same one-verification rule applies when consuming a challenge.

Response contains a one-time challenge ID, a 256-bit random challenge and expiry. Only the challenge digest is persisted. The raw Supabase JWT and raw challenge are never written to the database or audit events.

### Consume a challenge

`POST /api/v1/identity-links/challenges/{challenge_id}/consume`

Requires both authentication factors again. Body is exactly `{"challenge":"<one-time challenge>"}`. Both identities must match the original challenge issuer/subject pair. Challenge consumption, pending link request creation and the immutable requested event are one D1 batch. Replay, expiry, identity mismatch and duplicate consumption fail closed.

## Independent tenant-owner review

### List pending requests

`GET /api/v1/tenants/{tenant_id}/identity-links/pending`

Requires an active Core tenant owner authenticated through Cloudflare Access. The queue is scoped to the exact Access issuer and to requests whose Cloudflare subject has an active membership in the selected tenant. Supabase identity is not used for authorization.

### Decide a request

`POST /api/v1/tenants/{tenant_id}/identity-links/{request_id}/decision`

Body is exactly:
`{"decision":"approve|reject|revoke","reason":"...","idempotency_key":"..."}`

The actor is derived from the verified Access gateway envelope, never from request JSON. Core checks active tenant-owner membership, the request's exact Cloudflare issuer, the requester's active membership in the selected tenant for approval/rejection, independent review (no self-approval/rejection), allowed lifecycle transition, and idempotency key consistency. Revocation remains available to an active tenant owner even if the linked member has since been deactivated or removed. Approval activates only the identity-link record; it does not provision memberships, roles or grants.

Revocation is an explicit owner action. It does not silently reactivate a revoked link.

## Security boundaries

- Existing tenant routes continue to authorize only from Cloudflare Access.
- Supabase identity is only a second independently verified identity for this challenge ceremony; it is not a tenant principal.
- No email matching, UUID equality, browser-supplied identity, tenant ID, role or approver is trusted.
- Distinct issuers are required in application validation and the database trigger.
- Private gateway HMAC binds path, body digest, Supabase-token digest, Access identity, timestamp and request ID.
- The gateway and private Worker remain separate authentication boundaries.
- Supabase verifier currently supports RS256/JWKS. The real Supabase project's signing mode, issuer, audience and key-rotation behavior must be confirmed before production configuration.
- No automatic tenant provisioning or grants occur.

## Validation

Tests cover gateway route mapping, mandatory Supabase bearer token for challenge endpoints, signed body/token forwarding, private Worker owner-review actor derivation, tenant-scoped pending queue lookup, idempotency forwarding, challenge helper verification and SQL review constraints. Full ordered migrations and local Service Binding integration run in CI.

Passing CI is not production deployment or confirmation of the real project's JWT configuration.
