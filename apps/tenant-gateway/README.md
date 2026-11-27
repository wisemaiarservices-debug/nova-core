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


## Runtime configuration contract

The following non-secret Worker variables are required before activation:

| Variable | Gateway | Private API | Purpose |
|---|---:|---:|---|
| `NOVA_ACCESS_TEAM_DOMAIN` | Yes | No | Fixed Cloudflare Access team hostname used to construct the JWKS URL |
| `NOVA_ACCESS_AUDIENCE` | Yes | No | Exact Access application AUD tag |
| `NOVA_INTERNAL_KEY_ID` | Yes | Yes | Active HMAC key identifier; must match on both Workers |
| `NOVA_INTERNAL_ISSUER` | Yes | Yes | Exact internal assertion issuer; must match on both Workers |
| `NOVA_INTERNAL_AUDIENCE` | Yes | Yes | Exact private API assertion audience; must match on both Workers |

`NOVA_INTERNAL_HMAC_KEY` is a secret, not a plain-text Wrangler variable.
The identical key bytes and key ID must be available to the gateway signer and
private API verifier. Use a high-entropy key of at least 32 bytes. Never put
the value in source, checked-in configuration, CI output, logs or chat.

The gateway's Access team domain and audience are not interchangeable with the
internal assertion issuer and audience. Keep the two trust domains distinct.
The Access application must protect the gateway hostname; the private API must
remain reachable only through the fixed Service Binding.

## Activation gates and order

1. Create and verify the D1 database `nova-core-tenant-db`; replace the
   zero UUID in both `wrangler.tenant.jsonc` and
   `wrangler.nonce-cleanup.jsonc` with the same real database ID.
2. Review and apply the checked-in migrations to that database. Verify the
   nonce table, tenant isolation constraints and indexes before enabling reads.
3. Provision the same active HMAC key ID and secret in both Workers. Confirm
   issuer/audience values match exactly and establish an overlap/revocation
   procedure before any key rotation.
4. Create the Cloudflare Access application and policy for the gateway
   hostname. Confirm the expected audience tag and stable subject claim.
5. Deploy the private API with `workers_dev` disabled, then deploy the gateway
   with its fixed `TENANT_API` Service Binding. Keep the private API without
   a public route and do not expose the D1 binding to the gateway.
6. Deploy the scheduled cleanup Worker only after verifying it references the
   same D1 database and its cron schedule is acceptable.
7. Validate from the actual Cloudflare edge: unauthenticated denial, valid
   Access identity, invalid/expired JWT denial, HMAC tampering denial, replay
   denial, cross-tenant denial, D1 failure closed, response-size bounds and
   absence of public access to the private API.
8. Keep production activation blocked until all edge checks, observability
   redaction and rollback evidence are recorded.

The repository currently contains placeholder D1 IDs and no live Access
application, private API Worker, gateway Worker or HMAC secrets. These are
explicit external provisioning blockers, not completed deployment steps.
