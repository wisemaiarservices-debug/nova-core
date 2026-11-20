# Dual-identity local D1 integration: implementation readiness

Date: 2026-11-20
Status: engineering design note; no integration test execution or environment changes

## Objective

Extend the existing multi-Worker local D1 integration so that the production tenant gateway and production tenant API handler exercise the complete Supabase Auth + Cloudflare Access identity-link lifecycle against disposable local D1. The test must not use a mocked route database, call the identity-link persistence functions directly, accept browser-supplied identity claims, or add a production authentication bypass.

## Verified starting point

- Existing runner: `apps/tenant-api/scripts/d1-http-integration.mjs`.
- It launches Wrangler locally with `apps/tenant-gateway/wrangler.local-test.toml` and `apps/tenant-api/wrangler.d1-test.toml`, then sends requests through the gateway at loopback.
- Gateway verifies the Cloudflare Access JWT and creates a signed internal envelope; the private tenant API verifies that envelope before dispatching routes.
- Gateway forwards a bearer token only for the identity-link challenge create/consume routes and includes its SHA-256 digest in the HMAC envelope.
- Tenant API independently verifies the Supabase RS256 JWT via `verifySupabaseAccessToken`, fetching `{SUPABASE_AUTH_ISSUER}/.well-known/jwks.json`.
- The local API config currently defines Access issuer/audience and a CI-only internal HMAC secret, but does not define Supabase issuer/audience.
- The verifier supports an injected fetcher parameter at its lowest-level function, but `verifyIdentityLinkIdentityPair` currently does not expose that seam. The current local multi-Worker harness does not provide a verified local JWKS endpoint or a test-only resolver.
- The existing D1 fixture set includes two tenants and owner/member identities. The identity-link lifecycle is implemented in the production API route and persistence modules; protected site/observation reads require an approved identity pair in addition to tenant membership/resource grants.

## Critical implementation decision

Do not point the local test at a real Supabase project, use real user tokens, expose a test JWKS endpoint publicly, weaken issuer/algorithm/audience checks, or add a production env flag that skips signature verification.

Before adding lifecycle assertions, introduce a narrowly scoped dependency seam that keeps the production verifier unchanged in behavior:
1. Allow the identity-pair verifier to receive a JWKS fetcher only through an explicit dependency passed by a locally selected test entrypoint/factory, not from request data or ordinary production environment variables.
2. The normal production Worker must always use the platform `fetch` implementation and configured HTTPS issuer.
3. The local-only Wrangler entrypoint must inject a deterministic in-memory JWKS response for one exact synthetic HTTPS issuer and reject every other URL. The private key must be generated ephemerally by the test runner; only its public JWK is made available to the local verifier. Never write private keys to repository files, logs, fixtures, artifacts, or CI output.
4. Keep the test-only seam absent from the production entrypoint and deployment configuration. Add negative tests proving the production default path cannot be switched by request headers, query parameters, cookies, or ordinary env values.
5. If the Wrangler runtime cannot safely isolate this injected fetcher to the local entrypoint, stop and retain the current coverage gap; do not work around it with a weaker authentication path.

An alternative is a strictly local HTTPS JWKS server with certificate validation preserved and an explicit test trust configuration isolated to the local Wrangler process. Do not use HTTP issuer URLs: the production issuer validator requires HTTPS and an `/auth/v1` path.

## End-to-end acceptance sequence

Use synthetic identities only, with separate RSA keypairs and issuer/audience values for Access and Supabase Auth:
1. Valid Access + valid Supabase RS256 JWT can create a challenge through the gateway. Confirm response includes challenge once, while D1 stores only the challenge SHA-256 digest and no raw JWT or challenge.
2. Consume the challenge with the exact same two identities; assert one pending link request and immutable requested event.
3. Reuse the challenge; expect conflict/denial and no duplicate request/event.
4. Consume using a different Supabase subject, different Access subject, mismatched issuer/audience, expired JWT, bad signature, unknown `kid`, malformed/oversized JWKS, or missing Authorization; assert fail-closed behavior and no D1 state mutation.
5. Confirm the pending request is visible only to the correct active tenant owner in the matching Access issuer scope. Reject self-approval and cross-tenant review.
6. Approve with the active tenant owner; verify idempotent same-decision retry and conflicting idempotency reuse behavior.
7. Verify a protected site and site-observation read succeeds only when both the active membership/resource grant and the approved exact identity pair are present.
8. Revoke the approved link; protected reads must fail closed immediately after revocation.
9. Verify a second tenant cannot list, approve, read, or revoke the first tenant's identity-link records.
10. Inject audit-event persistence failure in disposable D1 and assert the transition rolls back atomically.
11. Exercise challenge expiry with a deterministic clock seam in the local test process; do not sleep five minutes in CI.
12. Confirm no bearer JWT, raw challenge, private key, or secret is persisted in D1, fixtures, logs, or workflow artifacts.

## Current blockers / unknowns

- No verified local JWKS injection mechanism is currently wired into the multi-Worker runner.
- Need inspect the complete gateway/API local entrypoint boundaries and the existing identity-link D1 fixtures before implementation.
- Need confirm migration fixtures include the identity-link challenge/request/event/rate-limit tables and two-tenant owner membership combinations.
- Need design deterministic clock and audit-failure hooks that are local-entrypoint-only and cannot be activated by public request input.
- No staging Access application/policy, deployed private Worker Service Binding, staging D1, or live dual-identity evidence has been verified.

## Scope and release boundary

This is a local CI engineering task only. It does not authorize or perform live Cloudflare configuration, Access policy changes, Supabase provisioning, remote D1 migrations, tenant/customer data access, secrets changes, deployment, production cutover, or paid resources. All pull requests remain draft until exact-head CI and independent security review are complete. Upwork marketplace payment rules remain in force; no off-platform payment or non-platform compensation arrangements.
