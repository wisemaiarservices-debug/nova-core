# Supabase Auth JWT verification boundary

This draft adds a standalone verifier for Supabase Auth access tokens in the NOVA Core private Tenant API codebase.

## Supported profile

- HTTPS issuer must be explicitly configured and end in the exact `/auth/v1` path.
- Audience must be explicitly configured; there is no default.
- Only asymmetric RSA RS256 access tokens are accepted. Legacy HS256 tokens and unsupported algorithms fail closed.
- JWKS is fetched only from the configured issuer's `/.well-known/jwks.json`; token-controlled `jku` and `x5u` are rejected.
- The selected signing key must have a matching unique `kid`, RSA modulus of at least 2048 bits, exponent 65537, and compatible signing metadata.
- JWT signature is verified before claims are trusted.
- Exact issuer, configured audience, non-empty subject, `role=authenticated`, expiry, issue time and optional not-before are checked.
- JWKS response and token sizes are bounded. Redirects are rejected.

## Important compatibility and release limits

Supabase projects using legacy HS256 JWT signing secrets are intentionally unsupported by this verifier. Before any integration, confirm the project's active signing-key configuration is asymmetric RS256 and test key rotation against its real JWKS. This implementation does not silently fall back to the Supabase JWT secret.

This module is not wired to a route, does not create or approve identity links, does not authorize tenants, and does not change the Cloudflare Access verifier. It only returns the verified Supabase issuer/subject pair for a future challenge ceremony. NOVA Core membership and grants remain authoritative.

No Supabase project URL, signing key, service-role secret, Cloudflare configuration, production route, deployment or live data is configured or changed by this PR.

## Gateway-bound token verification

The private Tenant API can now accept an optional Supabase bearer token forwarded by the Cloudflare Access gateway over its private Service Binding. The gateway computes SHA-256 over the exact bearer-token bytes and includes the digest in the HMAC-signed internal envelope. The private Worker independently recomputes that digest and verifies the JWT against the explicitly configured `SUPABASE_AUTH_ISSUER` and `SUPABASE_AUTH_AUDIENCE`.

The gateway accepts the browser's standard `Authorization: Bearer <token>` header only; CORS preflight permits `Authorization` for the configured exact origins. The raw token is forwarded only as an internal header and is neither persisted nor included in response payloads. Do not log request headers or token material.

This is an optional verification layer for compatibility: requests without a Supabase token continue to be Cloudflare-Access-only and MUST NOT be treated as proof of a linked Supabase identity. Supplying a token verifies it independently but does not link the Supabase identity to the Cloudflare identity, authorize a tenant, or grant access. The one-time challenge plus independent tenant-owner review protocol remains a separate, disabled workflow.

Before enabling this path in a deployment, confirm the project's actual asymmetric signing mode, exact issuer and audience, configure both Worker variables, and test a real token and key rotation in a non-production environment. No production configuration is set by this change.
