# NOVA Core Human Access Identity — Design Gate V1

Status: design decision only. Human identity implementation and tenant-route exposure remain blocked until the runtime boundary and Cloudflare Access configuration are proven.

## 1. Decision

Use Cloudflare Access at a trusted JavaScript Worker edge. Prefer Cloudflare's native Worker Access identity context (`ctx.access`) when the Worker is directly invoked through Access. Do not manually parse a browser-supplied identity header or treat decoded JWT claims as verified.

The existing Python `cloudflare_access_identity.py` is a claims adapter for service tokens; its docstring requires upstream RS256/JWKS signature verification. It is not a signature verifier or a human identity adapter.

The ingestion Worker's `access-auth.mjs` verifies RS256 service-token JWTs with Web Crypto and a JWKS cache. Its policy requires service-token form (`type=app`, empty `sub`, non-empty `common_name`). It must not be reused as the human identity policy.

## 2. Preferred human identity boundary: native Worker Access

Cloudflare documents that Worker-level Access protects the Worker across routes, custom domains, its `workers.dev` hostname and preview deployments. Configure it for **all traffic**, not previews only, and do not add bypass policies for tenant routes.

At the directly invoked JavaScript Worker:

1. Require `ctx.access` to exist. If it is absent, deny.
2. Call `await ctx.access.getIdentity()`. If identity retrieval fails or returns no usable identity, deny.
3. Use a stable Cloudflare Access user identifier as the principal subject: the verified application-token `sub` or the documented `user_uuid` identity field, after confirming the actual `ctx.access.getIdentity()` shape in an isolated Worker test.
4. Treat email as display/contact metadata only. Never use email, group name, URL, request body, or UI state as the database authorization key or tenant entitlement.
5. Reject service-token identities on human routes (`service_token_status=true`, or service-token form with empty `sub` and `common_name`).

Cloudflare documents that the Access application-token `sub` is a stable user ID within an account, but changes if the user is removed and re-added or authenticates to another organization. The full identity response also exposes `user_uuid`. The canonical subject field must be selected and tested against the actual Worker identity shape; do not silently fall back to email.

### Critical Service Binding limitation

Cloudflare explicitly states that `ctx.access` applies only to the directly invoked Worker and is **not propagated through Service Binding HTTP or RPC calls**. A downstream Python Worker therefore cannot trust the caller's `ctx.access` object or an ordinary forwarded subject header.

If the JavaScript edge Worker calls the Python API through a private Service Binding, the edge must mint a short-lived signed internal assertion after native Access authentication. The Python Worker must verify that assertion before constructing a principal. The assertion contract must include:

- fixed issuer and exact audience for the Python API;
- stable Access subject only; no tenant ID, role, permissions, or grant asserted by the browser;
- `iat`, `exp` with a short maximum lifetime, and unique `jti`;
- authenticated signing key ID and bounded key rotation;
- replay protection for `jti` at the receiving boundary, or a documented proof that replay cannot cross the private invocation boundary;
- strict algorithm pinning, constant-time signature verification, and fail-closed handling of tampering, expiry, wrong issuer/audience, unknown key, or replay.

The Python Worker must accept the assertion only over the private Service Binding and must have no public route that bypasses the verifier. Service Binding isolation constrains transport; it does not itself authenticate the human.

A same-Worker in-memory handoff avoids this additional assertion boundary. Do not assume Service Binding propagates Access identity.

## 3. Fallback: explicit Access JWT verification

Use manual JWT verification only if native `ctx.access` is unavailable and a signed Access JWT reaches a trusted edge component.

- Read only `Cf-Access-Jwt-Assertion` from the trusted request path. Never trust `Cf-Access-Authenticated-User-Email` or browser-supplied subject fields.
- Enforce a maximum token size of 16,384 ASCII characters and exactly three JWT segments. Reject duplicate JSON member names in the protected header and claims before parsing.
- Accept only `RS256`; require a non-empty `kid`; resolve keys only from the configured team's fixed `/cdn-cgi/access/certs` JWKS URL. Never follow token-supplied `jku` or `x5u` URLs.
- Validate RSA signing-key metadata, refresh JWKS once for an unknown `kid`, cache keys for a bounded interval, and fail closed on key retrieval or signature errors.
- Verify the signature before trusting or using any claim. Require exact configured issuer and application audience; valid integer `exp`, `iat`, optional `nbf`; sensible time ordering; and a bounded token lifetime with documented clock skew.
- Require `type=app` and a non-empty stable `sub`; reject service-token form on human routes.

Map authentication failures to generic 401 responses and JWKS/provider outages to generic 503 responses. Never expose token, signature, key, or provider internals.

## 4. Authorization and request flow

```text
Browser
  -> Worker-level Cloudflare Access (all traffic + previews)
  -> directly invoked JavaScript Worker (ctx.access)
  -> stable verified subject
  -> [private Service Binding + signed internal assertion, if Python is separate]
  -> tenant selector from route (not an entitlement)
  -> D1 membership loader (reconstructed PR #368)
  -> exact resource/action authorization (reconstructed PR #367)
  -> tenant-scoped read repository (reconstructed PR #369)
  -> response
```

- Access proves authentication, not tenant membership or authorization.
- Tenant IDs and resource IDs from URLs are selectors only.
- Roles and exact resource grants come only from tenant-scoped D1 records.
- Do not assign tenant roles from email domains, JWT group claims, client configuration, or UI state.
- Every tenant-facing read must use the authorization-first repository. Future writes require separate authorization-first write services and atomic audit persistence.
- Denied and absent resources remain indistinguishable to callers.
- Keep service-token ingestion identity and human-user identity as separate principal types and policy paths.

## 5. Runtime and deployment gate

No tenant routes may be exposed until all of the following are true:

1. Zero Trust/Access is enabled and a Worker-level Access policy protects production and preview traffic, with no bypass for tenant routes.
2. Every alternate hostname is covered. If Worker-level Access cannot be enabled, disable `workers_dev` and preview URLs for the tenant-facing Worker.
3. The actual `ctx.access.getIdentity()` shape and canonical stable subject field are verified in an isolated Worker test. Wrangler's local `access.dev` simulation is useful for unit tests but does not prove production Access configuration.
4. If the Python API remains a separate Worker, the signed internal assertion and Service Binding boundary are implemented and adversarially tested. No public Python API path may bypass the verifier.
5. Membership loading is connected to reconstructed PR #368 and reads to reconstructed PR #369; no request may provide its own principal or authorization records.
6. D1 migration and binding are reviewed and explicitly provisioned; audit behavior, tenant isolation, and integration tests pass.
7. Token/identity failures, service-token substitution, key rotation, JWKS outage, assertion replay, and cross-tenant access all fail closed.

## 6. Current implementation facts

- PR #367 (historical PR #36) supplies tenant policy and draft D1 schema primitives; its migration has not been applied.
- PR #368 (historical PR #38) loads trusted membership and exact grants from D1; it does not authenticate users.
- PR #369 (historical PR #39) supplies authorization-first tenant-scoped reads; it does not authenticate users or expose routes.
- The latest read-only Cloudflare account inventory found no zones, no D1 databases, and Access API status `access.api.error.not_enabled`; no Access application or policy is configured.
- The only deployed Worker in the account is `nova-core-api`; its current `workers_dev` and preview URL exposure are enabled. No tenant identity gate or Access coverage is proven. Do not expose tenant routes there.
- No D1 database, binding, tenant, membership, customer record, Access application, signed internal assertion, or human identity route is provisioned by this design.

## 7. Required tests

- `ctx.access` missing, identity retrieval failure, and missing stable subject all deny.
- Human identity resolves the exact stable subject; email changes do not change authorization identity.
- Service-token identity is rejected on human routes.
- Signed internal assertion rejects tampering, wrong issuer/audience, expired/future timestamps, unknown key, replayed `jti`, and unsupported algorithm.
- Service Binding cannot be called through a public bypass path.
- If JWT fallback is used: malformed/oversized token, non-RS256 algorithm, missing `kid`, invalid signature, wrong issuer/audience, expired token, future `iat`, invalid `nbf`, unknown `kid`, and JWKS outage are rejected.
- Browser-supplied tenant ID cannot grant access without exact D1 membership and resource grant.
- No route accepts caller-supplied `principal_subject` or authorization records.

## 8. References

- Cloudflare Workers Access and `ctx.access`: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Cloudflare Access application token and stable `sub` / service-token claim shape: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
- Cloudflare Access JWT validation fallback: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- Existing NOVA Core service-token verifier: `apps/ingestion-worker/src/access-auth.mjs`.
