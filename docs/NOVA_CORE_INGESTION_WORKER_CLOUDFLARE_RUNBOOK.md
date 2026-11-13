# NOVA Core isolated ingestion Worker — Cloudflare setup runbook

## Current implementation and deployment status

The isolated Worker source is in `apps/ingestion-worker/`. It now contains:
- Cloudflare Access RS256/JWKS verification and exact service/module/source grants.
- Strict observation payload validation.
- Active site/source/asset ownership checks with server-derived tenant ownership; legacy unowned records and cross-tenant combinations fail closed.
- Transactional D1 observation + tenant-owned audit writes, stable idempotency, and server-owned `unverified` status.

**None of this is deployed or live-integrated yet.** No D1 database/binding, Access application/policy, service token, Worker variables, or ingestion Worker deployment has been created. Tests use mocked D1 bindings. The existing public NOVA Core API remains unchanged.

Do not attach the existing `nova-core-api` Worker to a service-token-only Access application. Its public health and NASA POWER read endpoints are used by browser dashboards.

## Free-tier quota assessment (checked 2026-11-10)

Cloudflare's current official D1 documentation lists the following Workers Free allowances:
- **5 million rows read per day**
- **100,000 rows written per day**
- **5 GB total storage across the account**
- **500 MB maximum size per D1 database**
- **10 D1 databases per Free account**
- **50 D1 read subrequests per Worker invocation**

The D1 daily read/write limits reset at 00:00 UTC. If daily read/write quotas are exceeded, D1 queries fail until the reset; the Free plan does not automatically provide paid overage capacity. Storage exhaustion prevents additional inserts and schema changes until data is cleaned up or databases are removed. D1 usage counts rows read/written, including index effects; creating indexes can increase writes while reducing reads.

Cloudflare Zero Trust account limits currently list up to 50 custom applications on Zero Trust Free and 50 service tokens per account. Confirm the account's actual plan and dashboard quota before creating resources.

Official references:
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/reference/faq/
- https://developers.cloudflare.com/cloudflare-one/account-limits/
- https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

**Cost decision:** D1 is available on the Free plan and can remain $0 if usage stays within these limits and the account remains on Workers Free. This is not a guarantee against unrelated account charges or a later plan change. Do not upgrade, enable paid features, or accept a usage commitment. If the dashboard asks for payment details or an upgrade, stop.

## Tenant ownership requirement

The observation envelope does not accept `tenant_id`. The Worker resolves an active site, source and optional asset from D1, requires all records to belong to the same active tenant, and derives the tenant ID server-side. Legacy records with `NULL tenant_id`, suspended tenants, disabled sources, and cross-tenant site/source/asset combinations are rejected. The same derived tenant ID is written to both the observation and its audit event in one D1 batch. Verification remains `unverified` after acceptance.

The tenant schema requires the ordered migrations `0001_initial.sql` → `0002_tenant_isolation.sql` → `0003_internal_request_nonces.sql` → `0004_tenant_ownership_immutability.sql`. Do not run ingestion against a pre-tenant schema.

## Intended deployment shape

- Ingestion Worker name: `nova-core-ingest-api`
- No public `workers.dev` or preview hostname is enabled (`workers_dev = false`, `preview_urls = false`). A dedicated custom hostname/route must be selected and protected by Access before deployment.
- Public read-only API remains: `nova-core-api.neohaven.workers.dev`
- D1 binding name expected by the Worker: `DB`
- Migrations: `apps/api/migrations/0001_initial.sql` through `0004_tenant_ownership_immutability.sql` (ordered chain)

The dedicated ingestion hostname is separate so Access can require Service Auth without blocking browser-facing read endpoints.

## Deployment and provisioning sequence — do not skip gates

### Gate 1 — verify account plan and quotas

1. Confirm Cloudflare Workers is still on the Free plan.
2. Check D1 availability, the remaining database count, storage, and daily read/write usage.
3. Confirm Zero Trust Free is active and a custom Access application and service token can be created without payment.
4. Stop if a payment method, upgrade, paid feature, or non-zero usage commitment is required.

### Gate 2 — create and protect the isolated Worker

1. Select a dedicated custom hostname and route for the ingestion Worker; do not enable `workers.dev` or preview URLs.
2. Create a self-hosted Access application for that exact hostname before exposing the route.
3. Create a policy with action **Service Auth** and include only the intended service-token identity. Do not add Everyone, broad Allow, or Bypass rules.
4. Configure the Worker route and deploy with a narrowly scoped Cloudflare API token only after D1 and Access are ready.
5. Confirm unauthenticated requests are denied by Access and the public NOVA Core API remains outside this Access application.

### Gate 3 — configure server-side identity and grants

Set these Worker-side variables:
- `ACCESS_ISSUER`: exact Access team issuer, e.g. `https://<team-name>.cloudflareaccess.com`.
- `ACCESS_AUDIENCE`: exact AUD tag for the Access application.
- `NOVA_SERVICE_GRANTS_JSON`: exact service-token client ID mapped to explicitly approved module/source IDs.

Example allowlist shape (replace placeholders with actual registered identities):
```json
{
  "REPLACE_WITH_SERVICE_TOKEN_CLIENT_ID": {
    "neoagro": ["REPLACE_WITH_REGISTERED_SOURCE_ID"]
  }
}
```

The Client Secret belongs only in the trusted calling module backend, where it is sent to Cloudflare Access. Access sends a signed JWT assertion to the Worker. Never put the secret in a browser, `NEXT_PUBLIC_*`, repository, logs, or NOVA OS local storage.

### Gate 4 — create D1 and bind only after plan/quota approval

1. Create one D1 database for the shared NOVA Core registry; do not create separate databases per module.
2. Bind it to the ingestion Worker as `DB`.
3. Apply `apps/api/migrations/0001_initial.sql` to that database.
4. Verify all five required tables and indexes exist.
5. Check database size and usage immediately after migration.
6. Do not seed fictitious sites, coordinates, assets, sources, or observations. Register only real, approved records.

### Gate 5 — live integration tests before enabling module callers

- No Access credentials: Access denies before Worker execution.
- Wrong JWT issuer, audience, signature, expiry, or service-token claims: rejected.
- Authenticated service with wrong module/source grant: HTTP 403.
- Unknown/inactive site, disabled/mismatched source, or cross-site asset: HTTP 403.
- Valid authorized observation: HTTP 201, persisted once with `verification_status=unverified` and a service-attributed audit event.
- Identical retry with same source/idempotency key: HTTP 200 and original observation returned, no duplicate audit.
- Reuse of idempotency key with changed payload: HTTP 409.
- D1 outage/quota exhaustion: generic HTTP 503; no false success.
- Existing public NOVA Core health and NASA POWER endpoints remain readable.
- Verify row counts, audit records, `rows_read`, `rows_written`, and storage in Cloudflare dashboard.

Do not connect module backends until these live tests pass. Website reachability and API health do not prove field telemetry validity.

## Stop conditions

Stop before provisioning if the account is not on the expected free plans, quotas are unavailable, a payment/upgrade prompt appears, or any permission is broader than required. Do not create service tokens until the Access app/policy and the calling backend's secret storage are ready.

The implementation is branch-only until the user explicitly approves deployment and provisioning. No database, Access policy, service token, or ingestion Worker has been created by this runbook.
