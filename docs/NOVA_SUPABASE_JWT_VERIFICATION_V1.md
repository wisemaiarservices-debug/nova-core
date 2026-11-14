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
