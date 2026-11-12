# NOVA private tenant API Worker

This Worker is deliberately private. It has no public route, custom domain,
workers.dev hostname or preview URL. Its only intended caller is the
`nova-core-tenant-gateway` Service Binding.

## Required bindings (not configured)

- `DB`: approved Cloudflare D1 database after tenant migration 0002 and replay-protection migration 0003 are reviewed
  and applied.
- `ACCESS_ISSUER`: exact Cloudflare Access team issuer origin.
- `ACCESS_AUDIENCE`: exact human Access application audience.
- `INTERNAL_AUTH_SECRET`: same independently provisioned Worker secret as the gateway (minimum 32 characters); never commit it or put it in Wrangler vars.

No binding or secret is provisioned by this repository change.

## Read-only API

The Worker supports only exact resource reads for sites, assets, sources,
observations and audit events. Every request resolves one active membership,
checks the role's read ceiling, requires an exact resource/action grant, and
then performs a parameterized query constrained by both tenant ID and resource
ID. Missing and denied resources share a 404 response. D1 failures fail closed.

## Trust assumptions

The gateway signs the exact HTTP method/path, verified subject, issuer, audience,
timestamp and request ID with HMAC-SHA256. This Worker verifies the signature
before any D1 lookup and fails closed if the secret is absent or invalid. Both
Workers require the same independently generated secret, provisioned only via
the platform secret store. The timestamp window is 120 seconds. Each request ID is atomically consumed in
`internal_request_nonces` before tenant reads; duplicate IDs fail with 401.
Migration `0003_internal_request_nonces.sql` must be applied after migration
0002. Expired nonce rows can be pruned after 10 minutes using a reviewed
maintenance job; timestamp validation remains independently enforced. Each
accepted request consumes one D1 write, so free-tier write quotas must be
checked against expected traffic before enabling this path. The private Service Binding boundary is still
mandatory: do not add public routes, workers.dev hosts, preview URLs, or callers.

## Deployment gate

Deploy this target before the gateway that references it, but only after:
Access and D1 approvals, migrations 0002 and 0003 plus rollback/retention review, Wrangler validation,
private-origin isolation tests, and explicit human approval. This PR does not
authorize deployment or production resource creation.
