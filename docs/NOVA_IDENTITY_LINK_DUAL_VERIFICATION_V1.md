# NOVA Core dual-identity verification helper v1

## Purpose

`verifyIdentityLinkIdentityPair` is the narrow server-side preparation step for a future identity-link challenge route. It returns a minimal, frozen pair of independently verified identities:

- Supabase Auth: `(issuer, subject, audience)`, verified from the supplied bearer JWT using the explicitly configured issuer JWKS and audience.
- Cloudflare Access: `(issuer, subject, audience)`, accepted only from the private gateway envelope after the existing gateway HMAC, Access issuer/audience, timestamp, request-ID and replay checks have succeeded.

The two issuer strings must differ. The helper does not accept browser-supplied identity claims as a substitute for the verified Cloudflare envelope.

## Required call order

1. The public gateway verifies the Cloudflare Access JWT and signs the private envelope.
2. The private Worker verifies the envelope, exact configured Access issuer/audience, time bounds and request nonce.
3. Only the future identity-link route passes the resulting trusted Cloudflare envelope identity and the forwarded Supabase bearer token to this helper.
4. The helper independently verifies the Supabase JWT against the configured Supabase issuer/JWKS/audience and rejects issuer equality.
5. The route may pass the returned pair to the one-time challenge service. The raw JWT must never be stored or included in the challenge or audit ledger.

The helper is not a replacement for steps 1–2. Its Cloudflare input is trusted only when the call site follows this precondition.

## Explicit non-goals

This helper does not:
- create, consume, or persist a challenge;
- authorize either identity for a Core tenant;
- infer a link from matching email addresses or UUIDs;
- provision tenant membership, roles or grants;
- enable identity-link HTTP routes;
- configure production issuer/audience values or signing keys.

Existing tenant routes continue to authorize exclusively with the verified Cloudflare Access subject. The helper is not currently wired into any HTTP route. The identity-link routes remain unavailable until a dedicated route implementation has complete gateway-to-Worker tests, atomic challenge consumption, independent tenant-owner review, and replay/cross-tenant/self-review tests.

## Configuration

The call site must supply non-empty, explicit values for:
- `accessIssuer` and `accessAudience` — the exact Cloudflare Access values already verified by the private Worker;
- `supabaseIssuer` and `supabaseAudience` — the actual Supabase project issuer and expected JWT audience, confirmed from project configuration.

The current verifier supports asymmetric RS256 Supabase JWTs with issuer-published JWKS. It intentionally rejects legacy HS256 tokens. Do not set production variables until the real project's signing mode, issuer, audience and key rotation behavior are confirmed.

## Validation

The focused tests create a test-only RSA key pair and JWKS endpoint, then cover:
- valid Supabase signature plus exact trusted Access envelope identity;
- immutable minimal output with no raw token;
- wrong Access issuer/audience;
- identical issuer rejection before JWKS retrieval;
- invalid Supabase token rejection without returning a partial pair.

These are unit tests, not proof of the live Supabase project's signing configuration or a deployed end-to-end identity bridge.
