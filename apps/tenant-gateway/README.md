# Private tenant gateway security module

This package contains the gateway-side HMAC assertion signer only. It is not an
active gateway and intentionally exposes no route.

## Trust contract

1. Cloudflare Access must authenticate the user at the gateway hostname.
2. A dedicated Access JWT verifier must validate the `Cf-Access-Jwt-Assertion`
   signature against Cloudflare's published signing keys and enforce the
   configured team issuer, application audience, expiry and not-before claims.
3. Only the verifier's resulting trusted subject may be passed as
   `verifiedAccessIdentity` to `createInternalAssertion`. Never derive this
   value from `Cf-Access-Authenticated-User-Email`, arbitrary request headers,
   query parameters or request bodies.
4. The signer binds the internal assertion to GET and the exact canonical
   tenant-resource path. It uses a runtime secret binding, a key ID and a
   maximum 120-second lifetime.
5. The gateway must send the assertion over a private Service Binding. The
   private API must verify it, atomically consume its `jti`, then load D1
   membership and exact resource grants before returning data.

The present implementation does not yet include the Access JWT verifier,
gateway request handler, private Service Binding, D1 binding, or secret
provisioning. The Worker entrypoint is intentionally inert and
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
