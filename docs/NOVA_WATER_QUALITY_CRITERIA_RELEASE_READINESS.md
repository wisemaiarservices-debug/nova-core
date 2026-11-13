# NOVA water-quality criteria release readiness gates

## Current release decision

**Do not merge or deploy the criteria workflow to production yet.** The code path has passing automated CI against disposable local D1 and a local Access gateway/private Worker Service Binding, but production identity, database and source-evidence controls are not provisioned or verified.

The current tenant API Wrangler configuration intentionally has no D1 binding, Access issuer/audience configuration, routes or custom hostname. The gateway has only a private Service Binding declaration and no production hostname/Access policy. The CI-only D1 and gateway TOML files contain placeholder database IDs and test secrets and must never be used for deployment.

## Required before staging

- Provision a dedicated non-production D1 database through the approved Cloudflare account.
- Configure a real Cloudflare Access application and policy for the gateway hostname, with named human users and least-privilege groups.
- Configure the private tenant API Service Binding; do not expose the tenant API through workers.dev or a public route.
- Set Access issuer/audience and the internal HMAC secret as encrypted environment secrets/vars in the correct Workers. Never reuse CI fixture values.
- Apply migrations 0001–0008 to staging only after backup and migration review; record migration IDs and verify foreign keys/triggers.
- Run authenticated staging smoke tests for tenant isolation, suspended tenant denial, draft creation, reviewer assignment/revocation, submission, independent approvals, reviewer reads, resolution and sample comparison.
- Verify rate limits, request size limits, nonce retention, log redaction, alerting, D1 backup/restore and audit retention.
- Confirm no unexpected billing or paid services are enabled. Monitor free-tier usage before any staging traffic.

## Required before production

- A human regulatory reviewer and a separate domain expert must be independently identified and verified outside this API. The current assignment API records opaque Access subjects and caller-declared evidence references; it does not verify credentials, professional authority or independence.
- Source documents must be acquired from authoritative publishers, retained in controlled immutable storage, and independently hashed/verified. The current criteria API accepts a declared SHA-256 digest and evidence reference; it does not fetch or verify source files.
- Legal/domain experts must validate jurisdiction, version, effective dates, scope, clauses, units, amendments and supersession. No default thresholds are embedded.
- Conduct an independent security review of the Access trust boundary, reviewer provisioning authority, audit immutability, SQL transition triggers, tenant isolation and abuse controls.
- Obtain a named production owner and explicit change window, backup/rollback plan, and human approval for remote migrations and deployment.
- Run production smoke tests with a non-operational fixture before admitting real site data.

## Operational constraints

- An approved registry record is not proof of current law, scientific suitability or water safety.
- Sample comparisons are arithmetic comparisons to declared criteria only. No irrigation or treatment decision is automated.
- Unknown values stay unknown. No synthetic fixture, inferred measurement, or caller-declared source digest may be represented as verified field evidence.
- No production merge/deploy should be attempted while the required bindings, identity policies, source verification and human governance remain absent.
