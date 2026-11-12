# NOVA Core private tenant API trust boundary — architecture decision V1

## Status

Proposed, design-only. This document does not create Cloudflare resources, configure routes, provision D1, deploy Workers, or expose tenant endpoints.

## Context

NOVA Core has three separate security responsibilities:

1. Human authentication: PR #41 verifies a Cloudflare Access human JWT using a configured issuer, audience, JWKS and RS256.
2. Tenant authorization: PRs #36 and #38 resolve active membership and exact grants from D1; PR #39 performs authorization-first tenant-scoped reads.
3. Public scientific/data API: the existing `nova-core-api.neohaven.workers.dev` remains public for health and provider research endpoints such as NASA POWER, PVGIS and WaPOR metadata.

The public scientific API must not be placed behind a service-token-only Access policy. It must also not become an accidental proxy into tenant records.

## Decision proposed

Use a two-Worker boundary for human tenant APIs, physically separate from both the public scientific API and the ingestion Worker.

```text
Browser / NOVA OS
    |
    | Cloudflare Access human session
    v
nova-core-tenant-gateway (public hostname, Access-protected)
    |  1. Verify Cf-Access-Jwt-Assertion with PR #41 verifier
    |  2. Construct immutable principal from verified sub/issuer/audience
    |  3. Allow only explicit tenant API routes and methods
    |
    | Cloudflare Service Binding (not public HTTP)
    v
nova-core-tenant-api (private Worker; workers_dev=false; no public route)
    |  4. Validate gateway trust envelope
    |  5. Resolve membership + exact grants (PR #38)
    |  6. Perform tenant_id-scoped repository reads (PR #39)
    |  7. Return minimal response
    v
Shared D1 (tenant schema from PR #36)

Existing public nova-core-api ----------------> public read-only scientific/data endpoints
Existing isolated ingestion Worker ------------> service-token-only observation ingestion
```

This is a target topology, not a claim that Cloudflare resources or service bindings exist.

## Trust-boundary requirements

### Gateway

- Cloudflare Access application must cover the exact gateway hostname and all intended paths. Do not assume Access on a parent hostname protects a separate workers.dev hostname.
- Verify the Access JWT in the Worker using the configured issuer and audience. Never trust an identity header, query parameter, request body field, or caller-supplied subject.
- Reject missing/invalid identity-provider configuration with 503; reject invalid/expired/wrong-audience tokens with 401.
- Build a minimal principal only from verified claims. Do not forward raw JWTs, email addresses, or all token claims to the private API.
- Allowlist route + method pairs. No catch-all proxy, arbitrary URL, arbitrary host, or caller-selected upstream.
- Strip all incoming identity/trust headers before constructing the internal request.
- Apply bounded request/response sizes, no-store responses, explicit CORS origins, and non-cacheable authenticated responses.
- Never accept service tokens as human sessions.

### Private tenant API

- `workers_dev=false`; no public route, custom domain, or directly reachable workers.dev hostname.
- Accept traffic only through the configured Cloudflare Service Binding from the gateway Worker.
- A Service Binding is the network boundary, not an excuse to trust arbitrary headers on a public endpoint. If any public route is later added, the identity envelope must be cryptographically authenticated and replay-bounded.
- The internal worker must not expose an alternate health or debug route containing tenant state.
- It must independently validate the envelope schema and reject missing, malformed, stale, or unsupported principals.
- The envelope's subject must originate from the gateway's verified JWT, never from browser-controlled data.
- Tenant and resource IDs remain selectors only. Membership and exact grants in D1 are authoritative.
- Use PR #38 for membership/grant loading and PR #39 for all resource reads. No direct unscoped SQL lookups.
- Denied and not-found resources should remain indistinguishable to callers.
- Fail closed on D1 errors, duplicate membership, suspended tenant, revoked membership, invalid grants, or missing bindings.

### Internal identity envelope

Proposed minimal envelope fields:

- `subject`: verified stable Access `sub`, bounded non-empty string.
- `issuer`: exact configured issuer.
- `audience`: exact configured audience.
- `issued_at`: verifier-validated token issue time (Unix seconds).
- `request_id`: gateway-generated opaque request identifier.
- `method` and `path`: the exact allowlisted internal operation, not arbitrary routing instructions.

Do not include an authorization decision, tenant role, resource grant, or tenant ID as trusted entitlement. The private API re-resolves authorization from D1 on every request. Do not include email unless a narrowly justified display/audit use is approved.

The preferred first deployment is a Cloudflare Service Binding with a private Worker. If platform constraints require a public hop, stop and design a separate cryptographic envelope (HMAC with key rotation, canonical serialization, request binding and replay protection) before proceeding. Plain identity headers over public HTTP are prohibited.

## Tenant API V1 route scope

Start with read-only endpoints only:

- `GET /api/v1/tenants/{tenant_id}/sites/{site_id}`
- `GET /api/v1/tenants/{tenant_id}/assets/{asset_id}`
- `GET /api/v1/tenants/{tenant_id}/sources/{source_id}`
- `GET /api/v1/tenants/{tenant_id}/observations/{observation_id}`
- `GET /api/v1/tenants/{tenant_id}/audit-events/{event_id}`

For each request:

1. Validate path IDs and resource type.
2. Resolve the verified principal from the internal envelope.
3. Load exactly one active membership for subject + tenant.
4. Check tenant active state and exact resource/action grant.
5. Execute a parameterized SQL query constrained by both tenant ID and resource ID.
6. Re-check returned row tenant ID and resource ID.
7. Return 404 for both denied and missing resources; return generic 503 on storage failure.

No list/search endpoints, writes, user administration, tenant creation, grants management, or mutation APIs in V1. Those require pagination/limits, query isolation, audit transactions and explicit policy design.

## Required tests before any deployment

### Authentication

- Missing assertion, malformed JWT, forged signature, wrong issuer/audience, expired token, future issue time, unknown key ID and JWKS outage.
- Empty/missing subject and service-token claims rejected.
- Incoming spoofed identity headers cannot override the verified principal.
- Key rotation refresh succeeds only against the configured issuer.

### Boundary and routing

- Direct external requests to the private API cannot connect.
- Private Worker has no workers.dev hostname, custom domain or public route.
- Only the gateway Service Binding can invoke the private Worker.
- Unknown methods/paths are 404; no open proxy or path traversal.
- Public scientific API health and provider endpoints remain independently reachable.
- Ingestion Worker service-token policy remains separate.

### Authorization and data isolation

- No membership, duplicate membership, revoked membership and suspended tenant all deny.
- Exact resource grant required; wildcard or cross-tenant grant denied.
- A tenant A principal cannot read tenant B resources even when it knows the resource ID.
- SQL always binds tenant ID and resource ID.
- Denied and absent resource responses are identical.
- D1 errors return generic failure and never fall back to unscoped reads.

### Operations

- No secrets in browser bundles, repository, logs or URL parameters.
- D1 quota and retention monitoring; bounded query counts.
- Request IDs in audit-safe logs without tokens or sensitive payloads.
- Rollback path preserves the public scientific API and existing ingestion Worker.
- Security review and human approval before enabling a real customer tenant.

## Deployment gates

1. Verify Cloudflare account plan, Workers limits and current billing; do not upgrade or enable paid features.
2. Confirm Service Binding support and deployment semantics for the actual Python/FastAPI Worker runtime. Do not assume a Python Worker can be a service-binding target without a working proof.
3. Decide whether to keep tenant API logic in Python behind a private Python Worker or implement the minimal tenant read service in the JS Worker. Avoid duplicating authorization policy without parity tests.
4. Apply migration #36 only after an approved D1 exists and a backup/rollback procedure is documented.
5. Configure Access application and gateway identity settings; no broad Allow or bypass policy.
6. Deploy private Worker and gateway to preview/staging only; verify private origin cannot be reached externally.
7. Run the full security matrix against a disposable test database with synthetic test fixtures clearly labelled as test data.
8. Only after all gates pass may a human approve any production resource creation or customer onboarding.

## Current verified state

- PR #36: tenant schema and fail-closed policy are draft code; migration not applied.
- PR #38: D1 authorization loader is draft code; no D1 binding.
- PR #39: authorization-first read repository is draft code; no routes wired.
- PR #40: human identity boundary design is draft code.
- PR #41: isolated RS256/JWKS human JWT verifier is draft code with CI passing; not wired to a route.
- Existing public Core API and ingestion Worker remain separate.
- No tenant D1, customer, membership, grant, Access app, gateway, private Worker, Service Binding or public tenant endpoint has been provisioned.

## Explicit non-goals

This design does not authorize autonomous irrigation, energy dispatch, battery control, device commands, or any other critical infrastructure action. Any future write/control capability must be separately scoped, audited, reviewed by an authorized human, and protected by domain-specific safety interlocks.
