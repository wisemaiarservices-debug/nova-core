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
timestamp, and a random request ID. Those fields plus the exact method/path are
HMAC-SHA256 signed using a high-entropy secret of at least 32 characters. The
same secret must be provisioned on both Workers through the platform secret
store, never in source or Wrangler vars. The private API enforces a 120-second
timestamp window, and each request ID is consumed once in the private API's
`internal_request_nonces` table before any tenant data read. Duplicate request
IDs are rejected; timestamp freshness remains an independent control. Browser
cookies, caller identity headers, query strings, request bodies and raw JWTs
are not forwarded.

## Deployment sequence

1. Review the complete migration chain in order: existing `0001` base schema,
   `0002_tenant_isolation.sql`, then `0003_internal_request_nonces.sql`. Confirm
   the target D1 identity, schema compatibility, backup/restore, ownership
   mapping and billing/quotas; do not apply migrations without explicit approval.
2. Configure a narrowly scoped Cloudflare Access application/policy for the
   exact gateway hostname; configure the issuer and audience.
3. Deploy the private tenant API first with no public hostname or route.
4. Prove the private Worker is unreachable from the public Internet and only
   callable through this gateway's Service Binding.
5. Deploy this gateway with the binding and Access settings, then attach the
   exact Access-protected hostname.
6. Run cross-tenant, identity, route allowlist, request-ID replay, migration
   and outage tests against a disposable D1 database before any customer
   onboarding. SQLite contract tests alone do not establish D1 compatibility.

No D1, Access application, secret, custom hostname, route, or deployment is
created by this repository change.


## Local end-to-end integration (CI only)

The tenant Worker CI starts Wrangler with two configurations at once:
`wrangler.local-test.toml` (gateway) and `../tenant-api/wrangler.d1-test.toml`
(private API). Wrangler's local Service Binding connects the gateway to the
private API Worker; the private API uses the disposable local D1 database.
The gateway test-only entrypoint runs the same RS256 JWT verifier as production
but injects a deterministic local JWKS fixture response (no separate JWKS
Worker or external issuer is contacted). Its paired RSA private key is
a committed test fixture and is not a Cloudflare Access credential.

The integration checks the full local gateway-to-private-Worker Service
Binding path, including signed JWT verification, internal HMAC envelope
creation/verification, D1-backed tenant membership and exact resource grants,
cross-tenant denial, invalid JWT rejection, and caller identity-header/cookie
isolation. The regular private API tests separately cover internal nonce replay
and tampered HMAC envelopes.

This is a local workerd/Miniflare simulation, not proof of Cloudflare edge
Access enforcement, deployed Service Binding isolation, production secret
provisioning, remote D1 operation, or live tenant readiness. The test-only
gateway entrypoint/configuration must never be deployed.
