# Private tenant gateway security module

This package contains the Cloudflare Access verifier, HMAC assertion signer
and Service Binding request forwarder. Its Worker is intentionally not exposed
through workers.dev or a public route.

## Trust contract

1. Cloudflare Access must authenticate the user at the gateway hostname.
2. The gateway calls `verifyCloudflareAccessJwt` with the Access JWT from the
   `Cf-Access-Jwt-Assertion` header, a fixed team domain and the configured
   application audience. The verifier checks the RS256 signature against the
   team's fixed JWKS endpoint and validates issuer, audience, expiry,
   not-before and subject claims.
3. Only the verifier's module-branded identity may be passed as
   `verifiedAccessIdentity` to `createInternalAssertion`. Plain objects and
   values copied from `Cf-Access-Authenticated-User-Email`, arbitrary request
   headers, query parameters or request bodies are rejected.
4. The signer binds the internal assertion to GET and the exact canonical
   tenant-resource path. It uses a runtime secret binding, a key ID and a
   maximum 120-second lifetime.
5. The gateway forwards only the signed GET request over the fixed
   `TENANT_API` Service Binding. It drops query strings and request bodies,
   bounds upstream response size, and returns only a safe JSON response.
6. The private API verifies the assertion, atomically consumes its `jti`,
   then loads D1 membership and exact resource grants before returning data.

The Access JWT verifier, assertion signer and request forwarder are implemented
and covered by offline tests. The Wrangler config declares the intended
`TENANT_API` Service Binding, but the target Worker, D1 binding, Cloudflare
Access application/policy, hostname route and runtime secrets are not
provisioned in the live account. The Worker has `workers_dev` disabled and no
public route. Do not deploy it until those external gates pass.

## Runtime secrets

When the full boundary is ready, provision the HMAC secret through Cloudflare's
secret interface. Never add secret values to this repository, Wrangler vars,
logs, fixtures or chat. The same key material must be configured in the gateway
signer and private API verifier under the same key ID, with a documented
rotation overlap.

## Tests

Run `npm test` in this directory. Tests validate token structure, HMAC
compatibility, unique request IDs, identity input gating, request method/path
allowlisting, time bounds and configuration failures.
