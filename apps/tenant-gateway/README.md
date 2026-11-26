# Private tenant gateway security module

This package contains the gateway-side HMAC assertion signer only. It is not an
active gateway and intentionally exposes no route.

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
5. The gateway must send the assertion over a private Service Binding. The
   private API must verify it, atomically consume its `jti`, then load D1
   membership and exact resource grants before returning data.

The Access JWT verifier and assertion signer are implemented and covered by
offline tests. The gateway request handler, private Service Binding, D1 binding,
Cloudflare Access application/policy, and runtime secret provisioning are not
implemented or configured. The Worker entrypoint is intentionally inert and
`workers_dev` is disabled. Do not deploy it.

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
