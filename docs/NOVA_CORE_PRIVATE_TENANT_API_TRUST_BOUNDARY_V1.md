# NOVA Core private tenant API trust boundary — architecture decision V1

Status: proposed, design-only. This document does not create Cloudflare resources, configure routes, provision D1, deploy Workers, or expose tenant endpoints.

## 1. Security responsibilities

NOVA Core has three separate security responsibilities:

1. **Human authentication:** Cloudflare Access at a trusted JavaScript Worker edge. Prefer native `ctx.access.getIdentity()` for the directly invoked Worker (human identity design in reconstructed PR #370).
2. **Tenant authorization:** active membership and exact resource grants from D1, evaluated by reconstructed PR #367 policy and PR #368 loader; reconstructed PR #369 performs authorization-first tenant-scoped reads.
3. **Public scientific/data API:** existing `nova-core-api.neohaven.workers.dev` health and provider-research endpoints (NASA POWER, PVGIS, WaPOR metadata) remain separate. They must not become a proxy into tenant records.

The ingestion Worker remains a separate service-token-only observation ingestion boundary. Human sessions and machine service tokens are distinct principal types and must not share authorization policy.

## 2. Target topology

Use a two-Worker boundary for human tenant APIs, physically separate from the public scientific API and ingestion Worker:

```text
Browser / NOVA OS
    |
    | Cloudflare Access (Worker-level; all traffic + previews)
    v
nova-core-tenant-gateway (JavaScript Worker)
    |  1. Require ctx.access and getIdentity()
    |  2. Resolve stable Access subject (never email as authorization key)
    |  3. Allowlist exact tenant API route + method pairs
    |  4. Mint short-lived signed internal identity assertion
    |
    | Private Cloudflare Service Binding
    v
nova-core-tenant-api (Python Worker; workers_dev=false; preview_urls=false)
    |  5. Verify internal assertion and request binding
    |  6. Resolve membership + exact grants (PR #368)
    |  7. Perform tenant_id-scoped repository reads (PR #369)
    |  8. Return minimal response
    v
Shared D1 (tenant schema from PR #367; not provisioned)

Existing public nova-core-api ----------------> public health/research endpoints only
Existing isolated ingestion Worker ------------> service-token-only observation ingestion
```

This is a target topology, not a claim that Cloudflare resources or service bindings exist.

## 3. Gateway trust requirements

- Protect the gateway Worker itself with Worker-level Cloudflare Access for all traffic, including routes, custom domains, `workers.dev` and previews. Do not add Access bypass rules for tenant paths.
- Require `ctx.access` and `await ctx.access.getIdentity()`; missing context or identity retrieval failure denies.
- Use a stable Access user identifier only after testing the actual identity object shape. Email is display/contact metadata, never the authorization key.
- Reject service-token identities on human routes.
- Do not trust browser-supplied identity headers, subject, tenant ID, role, grant, or permission fields.
- Allowlist exact route + method pairs. No catch-all proxy, arbitrary URL, arbitrary host, or caller-selected upstream.
- Strip inbound identity/trust headers before constructing the internal request.
- Apply bounded request/response sizes, `Cache-Control: no-store`, explicit CORS origins, and non-cacheable authenticated responses.
- Do not forward raw Access JWTs, cookies, email, or all identity claims to the private API.

Cloudflare documents that `ctx.access` applies only to the directly invoked Worker and is not propagated through Service Binding HTTP or RPC calls. The private Python Worker must therefore not assume it can read the gateway's Access context.

## 4. Private tenant API requirements

- `workers_dev=false`; preview URLs disabled; no public route, custom domain, or directly reachable workers.dev hostname.
- Accept requests only through the explicitly configured gateway Service Binding.
- Verify the signed internal identity assertion before constructing a principal. Service Binding isolation alone does not propagate or prove the human identity.
- Verify fixed issuer and exact audience, stable subject, short expiry, issue time, key ID, signature, request method/path binding, and one-time request ID.
- Enforce replay protection for the assertion's `jti`. A bounded, durable replay store must be part of the D1 design or a separately approved no-cost primitive; do not claim replay protection from an in-memory per-isolate cache.
- Fail closed on malformed, stale, replayed, wrong-audience, wrong-issuer, or invalid-signature assertions.
- No public health/debug route may expose tenant state. The private Worker must not accept caller-supplied principal or authorization records.
- Tenant and resource IDs remain selectors only. D1 membership and exact grants are authoritative.
- Use reconstructed PR #368 for membership/grant loading and PR #369 for all resource reads. No direct unscoped SQL lookups.
- Denied and absent resources remain indistinguishable to callers. D1 errors return generic 503; no fallback to unscoped reads.

## 5. Internal identity assertion

The gateway-to-private-API assertion is a distinct credential, not the original Access JWT. Its proposed minimal claims are:

- `iss`: fixed gateway issuer;
- `aud`: exact private tenant API audience;
- `sub`: stable verified Access subject only;
- `iat` and `exp`: short bounded lifetime;
- `jti`: unique request identifier consumed once by the private API;
- `kid`: key version for controlled rotation;
- `method` and canonical `path`: exact allowlisted internal operation;
- optional `request_id` for safe correlation.

Do not include tenant role, resource grant, authorization decision, or tenant entitlement. The private API re-resolves membership and exact resource grants from D1 on every request. Do not include email unless a narrowly justified display/audit use is approved.

The assertion must be signed with a managed secret/key unavailable to browsers and verified with strict algorithm pinning and constant-time comparison where applicable. Key rotation must support a bounded overlap and explicit revocation. No secret is to be created or configured as part of this design-only PR.

## 6. Public scientific API and ingestion separation

- Keep `nova-core-api` public only for non-tenant health and research/provider endpoints. It must not forward to the private tenant API or expose tenant data.
- Do not put human tenant routes on the ingestion Worker.
- The ingestion Worker retains its separate service-token identity policy and scoped ingestion permissions.
- Never accept a service token as a human session or a human Access token as an ingestion credential.
- Keep CORS and public hostname configuration separate from authentication; CORS is not an authorization control.

## 7. Read-only V1 route scope

Start with read-only endpoints only:

- `GET /api/v1/tenants/{tenant_id}/sites/{site_id}`
- `GET /api/v1/tenants/{tenant_id}/assets/{asset_id}`
- `GET /api/v1/tenants/{tenant_id}/sources/{source_id}`
- `GET /api/v1/tenants/{tenant_id}/observations/{observation_id}`
- `GET /api/v1/tenants/{tenant_id}/audit-events/{event_id}`

For each request:

1. Validate path IDs and resource type.
2. Resolve the stable subject from the signed internal assertion.
3. Consume the assertion's one-time `jti`.
4. Load exactly one active membership for subject + tenant.
5. Check active tenant state and exact resource/action grant.
6. Execute a parameterized SQL query constrained by both tenant ID and resource ID.
7. Re-check returned row tenant ID and resource ID.
8. Return the minimum necessary projection; return 404 for denied and missing resources; return generic 503 on storage failure.

No list/search endpoints, writes, user administration, tenant creation, grants management, or mutation APIs in V1. Those require pagination/limits, query isolation, audit transactions and separate policy design.

## 8. Required tests before deployment

### Human authentication and internal assertion
- Missing `ctx.access`, failed identity retrieval, missing stable subject and service-token substitution all deny.
- Email changes do not change the durable authorization subject.
- Assertion tampering, wrong issuer/audience, expired/future timestamps, unknown key, revoked key, replayed `jti`, wrong method/path and unsupported algorithm all deny.
- Service Binding cannot be invoked through a public bypass path.
- Worker-level Access protects production, `workers.dev`, custom domains and preview traffic; bypass rules are absent.

### Routing and isolation
- Direct external requests to the private API cannot connect.
- Private Worker has no workers.dev hostname, preview URL, custom domain or public route.
- Only the gateway Service Binding can invoke the private Worker.
- Unknown methods/paths are 404; no open proxy or path traversal.
- Public scientific API health/provider endpoints remain independently reachable.
- Ingestion Worker service-token policy remains separate.

### Authorization and data isolation
- No membership, duplicate membership, revoked membership and suspended tenant all deny.
- Exact resource grant required; wildcard or cross-tenant grant denied.
- Tenant A cannot read tenant B even when it knows the resource ID.
- SQL always binds tenant ID and resource ID.
- Denied and absent resource responses are identical.
- D1 errors return generic failure and never fall back to unscoped reads.

### Operations
- No secrets in browser bundles, repository, logs or URL parameters.
- D1 quota/retention monitoring and bounded query counts.
- Request IDs in audit-safe logs without tokens or sensitive payloads.
- Rollback preserves the public scientific API and existing ingestion Worker.
- Assistant-led internal security review and human approval before enabling a real customer tenant.

## 9. Deployment gates

1. Verify Cloudflare account plan, Workers limits and billing; do not upgrade or enable paid features.
2. Enable Cloudflare Access and configure a Worker-level policy for the gateway, with no tenant-route bypass.
3. Confirm Service Binding support and deployment semantics for the actual Python/FastAPI Worker runtime.
4. Provision D1 only after the schema, replay-store strategy, backup and rollback plan are approved.
5. Implement and test the signed internal assertion; do not assume `ctx.access` crosses Service Binding.
6. Deploy gateway/private Workers to preview/staging only; verify the private origin cannot be reached externally and preview URLs are disabled on the private Worker.
7. Run the full security matrix against a disposable test database with synthetic fixtures clearly labelled as test data.
8. Only after all gates pass may a human approve production resource creation or customer onboarding.

## 10. Current verified state

- PR #367: tenant policy and draft D1 schema; migration not applied.
- PR #368: D1 authorization loader; no D1 binding.
- PR #369: authorization-first read repository; no routes wired.
- PR #370: native Worker Access identity and signed internal assertion design; no identity implementation.
- The latest read-only Cloudflare account inventory found no zones, no D1 databases, and Access API status `access.api.error.not_enabled`; no Access application or policy is configured.
- The only deployed Worker in the account is `nova-core-api`; its `workers_dev` and preview URL exposure are enabled. No tenant identity gate or Access coverage is proven. Do not expose tenant routes there.
- No D1, Access app, gateway, private Worker, Service Binding, tenant, membership, grant, replay store, signed assertion, or public tenant endpoint has been provisioned.

## 11. Explicit non-goals

This design does not authorize autonomous irrigation, energy dispatch, battery control, device commands, or any other critical infrastructure action. Any future write/control capability must be separately scoped, audited, reviewed by an authorized human, and protected by domain-specific safety interlocks.

## References

- Cloudflare Workers Access and `ctx.access`: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Cloudflare Service Bindings: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- Cloudflare Access application token and stable `sub`: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
- Cloudflare Access JWT validation fallback: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
