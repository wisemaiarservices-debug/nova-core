# NOVA tenant gateway Worker

The gateway is the only intended public entry point for human tenant reads. A
Cloudflare Access application must protect the exact custom hostname before a
route is attached. The Worker independently verifies the human
`Cf-Access-Jwt-Assertion` with the configured issuer/audience and RS256 JWKS.

## Required configuration (not provisioned)

- `ACCESS_ISSUER`: exact HTTPS Cloudflare Access team issuer origin.
- `ACCESS_AUDIENCE`: exact audience for the human Access application.
- `TENANT_API`: Service Binding to `nova-core-tenant-api`.
- `INTERNAL_AUTH_SECRET`: independently provisioned Worker secret (minimum 32 characters), identical on gateway and private API; never commit it or put it in Wrangler vars.

Do not expose a workers.dev or preview hostname. Do not add arbitrary proxy
routes. The gateway creates a fresh internal request and forwards only the
verified stable subject, configured issuer/audience, per-request gateway
timestamp, and a random request ID. Browser cookies, caller identity headers,
query strings, request bodies and raw JWTs are not forwarded.

## Deployment sequence

1. Review and approve the D1 tenant schema and billing/quotas.
2. Configure a narrowly scoped Cloudflare Access application/policy for the
   exact gateway hostname; configure the issuer and audience.
3. Deploy the private tenant API first with no public hostname or route.
4. Prove the private Worker is unreachable from the public Internet and only
   callable through this gateway's Service Binding.
5. Deploy this gateway with the binding and Access settings, then attach the
   exact Access-protected hostname.
6. Run cross-tenant, identity, route allowlist and outage tests against a
   disposable test database before any customer onboarding.

No D1, Access application, secret, custom hostname, route, or deployment is
created by this repository change.
