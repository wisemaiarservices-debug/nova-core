# NOVA Core first-site onboarding contract — v1

Status: integrated in draft PR #219 on the dual-identity provisioning branch. Combined exact-head CI passes 3/3. This does not enable production tenant or site creation.

## API

Public gateway: `POST /api/v1/tenants/{tenant}/sites`

Private Tenant API: `POST /internal/v1/tenants/{tenant}/sites`

Request headers:
- Cloudflare Access JWT (verified by the gateway)
- Supabase bearer token (verified independently by the private Tenant API)
- `Idempotency-Key` (1–160 characters; restricted identifier syntax)
- `Content-Type: application/json`

The exact-origin credentialed CORS preflight allows `Idempotency-Key` as well as the authorization and JSON headers required by the browser workflow.

Request body accepts exactly one field:

```json
{ "name": "North Farm" }
```

No caller-supplied site ID, tenant ID, actor, role, coordinates, timezone, geometry, asset, source, or sensor data is accepted. Site IDs and audit identifiers are generated server-side.

## Authorization

- The gateway verifies the Cloudflare Access JWT and signs the exact request envelope, including body digest and idempotency key.
- The private Worker independently verifies the signed envelope and Supabase bearer token.
- The Cloudflare and Supabase identities must already be linked and approved for the exact tenant.
- The actor must be the active `tenant_owner` of the active tenant. Admins and other roles cannot create a site.
- The owner and tenant are rechecked in the database statements that perform the write.
- The browser cannot select the actor, role, tenant, site ID, or initial grant recipient.

## Atomic creation

One D1 batch writes, in order:

1. An active site under the exact tenant.
2. An exact `read` grant for the authenticated owner on that site only.
3. The append-only site-grant event.
4. The append-only site-created event.
5. The immutable idempotency record, bound to tenant, actor, key, exact body SHA-256 and generated site ID.

Database triggers reject a site event unless the active owner, active site and initial read grant/event all exist. The idempotency trigger rejects a request record unless the site, site event and exact owner grant exist. Audit and idempotency tables reject UPDATE and DELETE. D1 batch failures roll back the operation.

A repeated key with the same body digest returns the original site without creating a second record. Reusing the key with a different digest returns HTTP 409. The idempotency key is covered by the gateway-to-private-Worker HMAC envelope.

## Explicit separation from data activation

Creating a site does not:
- create an asset or source;
- assign reviewers;
- verify a source or sensor;
- grant site access to another member;
- create an ingestion service grant or credential;
- enable provider transport or ingestion;
- mark any observation verified.

Source registration, independent source verification, service identity allowlisting, and observation review remain separate governed workflows. A site marked active is a tenant container, not evidence that its equipment, geometry, data or operations are configured or validated.

## Validation and release boundary

The draft includes:
- service-level tests for exact owner read grant, atomic write sequence, idempotent replay, conflicting key reuse, malformed input and failed batches;
- gateway tests for POST routing, signed idempotency forwarding, invalid key rejection and exact-origin CORS preflight;
- migration contract tests for immutable site events and idempotency records;
- ordered disposable-D1 migration and gateway/private-Worker integration CI.

No production migration, live grant, site, source, credential, environment change, merge or deployment is included. Production rollout still requires exact production Access/CORS and Supabase configuration, reviewed migrations, and approved operational smoke/rollback checks.


## Owner-only asset registration (draft follow-on)

Public gateway: `POST /api/v1/tenants/{tenant}/sites/{site}/assets`

Private Tenant API: `POST /internal/v1/tenants/{tenant}/sites/{site}/assets`

The request accepts only `name`, `asset_type`, and optional `external_ref`. The server generates the asset ID and binds the asset to the exact tenant and site from the route. The Cloudflare Access and Supabase identities must already be linked and approved for that tenant; the actor must be its active owner and hold the exact site read grant. Admins and other roles are denied in this initial onboarding workflow.

A single D1 batch creates the asset with status `unconfigured`, an exact asset-level `read` grant for the owner, the resource-grant audit event, an immutable asset-created event, and a tenant/site/actor-scoped idempotency record. Replaying the same key and body returns the original asset; a different body digest returns HTTP 409.

Asset registration does not assert that the equipment physically exists, is connected, is correctly configured, or has a known sensor identity. It does not register or verify a source, create a service credential, assign a reviewer, calibrate a sensor, or enable ingestion. Asset status remains `unconfigured` until a separate evidence-backed lifecycle exists.

The unified migration sequence follows tenant provisioning: `0026_tenant_provisioning_identity_binding.sql`, `0027_tenant_site_creation.sql`, `0028_tenant_asset_registration.sql`, `0029_tenant_source_registry_lifecycle.sql`, `0030_asset_tenant_site_composite_key.sql`, `0031_sensor_calibration_event_composite_key.sql`, and `0032_measurement_quality_verified_source_guard.sql`. The asset migration adds append-only event and immutable idempotency ledgers with active-owner and exact tenant/site/asset guards.


## Site-scoped source registration and independent verification (draft follow-on)

Public gateway routes:

- `POST /api/v1/tenants/{tenant}/sites/{site}/sources`
- `POST /api/v1/tenants/{tenant}/sites/{site}/source-reviewers/assign`
- `POST /api/v1/tenants/{tenant}/sites/{site}/source-reviewers/revoke`
- `POST /api/v1/tenants/{tenant}/sites/{site}/sources/{source}/verification`

Source registration is owner/admin-only and requires the exact active tenant, site and site-read grant. The request accepts module, provider, source type, display name, optional license reference and a source evidence reference. It deliberately does not accept endpoint URLs, credentials, tenant/site IDs, verification status or a source ID. Core generates the source ID, records the registrant and writes a registration event plus tenant/site/actor-scoped idempotency record. The source remains `unverified`.

A tenant owner/admin may assign an active tenant member as a site-scoped source reviewer. The registrant cannot review their own source. Verification/rejection/revocation requires an active assigned reviewer, an evidence reference and (for rejection/revocation) a reason. The source table's verification status is updated only by the database lifecycle-event trigger: `verified` after approval, `unverified` after rejection, and `disabled` after revocation. Rejected sources cannot be re-verified through this initial lifecycle.

The source registration evidence reference is a pointer, not proof that the referenced evidence is valid or that a physical device is connected. Verification is a human governance decision, not cryptographic proof of installation, accuracy, calibration, licensing or scientific validity.

The existing ingestion Worker continues to require `verification_status='verified'`, exact tenant/site/module/source matching, an active site/asset, Cloudflare Access service-token authentication and a separately configured exact service/module/source grant. Source registration and review do not create service credentials or grants and do not enable ingestion.

The source lifecycle endpoints authenticate the Cloudflare Access subject against active tenant membership and the route's site grant. They do not themselves perform a second Supabase identity-link check on every source action; this is an explicit authorization boundary to verify against the operator workflow before production enablement. Site creation, asset creation and site observation reads additionally require the approved Cloudflare/Supabase identity link for the exact tenant.


## Dual-identity tenant provisioning and Core mapping receipt (integrated draft)

Tenant provisioning is available only through the allowlisted gateway route `POST /api/v1/tenants`. The gateway verifies the Cloudflare Access identity and forwards a signed request envelope. The private Tenant API independently verifies the Supabase bearer token and a short-lived NOVA OS owner assertion signed by a pinned RS256 public JWK. The owner assertion must bind the exact Supabase issuer/subject and NOVA OS tenant, and assert active owner membership and active tenant status. The gateway subject must also be present in the Core provisioning subject allowlist.

Core creates the tenant, initial active owner membership, six initial tenant grants, immutable membership audit event, and idempotent provisioning ledger in one D1 batch. A durable mapping receipt binds both identities, both tenant IDs, the idempotency key, request digest, owner-assertion JTI and provisioning request JTI. The receipt is RS256-signed and expires after five minutes. A replay returns the durable provisioning result under the same identity and idempotency binding.

### Key handling clarification

The receipt signer imports the configured PKCS#8 PEM using Web Crypto with `extractable=false` and `sign`-only usage. This makes the in-memory CryptoKey non-extractable after import; it does **not** mean the original PEM secret is stored in an HSM or is non-extractable at rest. Production must supply the PEM through an approved Cloudflare secret-management process, restrict who can read/change that secret, pin the corresponding public JWK/key ID in NOVA OS, document rotation and revocation, and verify issuer/audience agreement. No private key or production secret is committed to this repository.

The draft Worker configuration intentionally has no public route, custom domain, D1 binding or Access configuration. Receipt signing fails closed with HTTP 503 when its required issuer, audience, key ID or private-key secret is absent. Owner assertion verification likewise fails closed when its pinned issuer, audience or public JWK is absent. Passing CI uses generated test keys and does not prove production keys or bindings are configured.

## Integrated CI and release boundary

PR #219's exact integrated head passed all three jobs: API tests, tenant Worker/D1 integration (including the ordered migration chain), and research raster tests. This is code-level validation only. It does not verify production Cloudflare Access policy, CORS allowlist, Supabase issuer/audience/signing algorithm, NOVA OS owner-assertion key, receipt-signing secret, production key pinning, pilot tenant/site evidence, ingestion service credentials/grants, rollback, or operational smoke tests.

No production migration, secret, binding, tenant, permission, source verification, ingestion activation, merge or deployment has been performed.


## Cross-repository NOVA OS integration audit — 2026-11-16

The current default branches of the `NovaOS` and `neohaven-nova-os-website` repositories were inspected for the server-side owner-assertion issuer. Neither currently contains a provisioning assertion endpoint, Supabase Edge Function, or server-side signing implementation. The visible application code is a frontend; therefore the issuer, audience and pinned public JWK expected by Core are currently an integration contract, not a verified working NOVA OS service.

The legacy `NovaOS` Supabase schema migration also defines broad `anon, authenticated` policies with unrestricted `USING (true)` / `WITH CHECK (true)` access for its dashboard tables. Treat that schema as demo-only. It must not be used as the tenant identity or sensitive production data store until its policies are replaced with least-privilege, tenant-aware RLS and the server-side owner assertion service is implemented.

Required upstream work before provisioning can be enabled:
1. Implement a trusted server-side NOVA OS owner-assertion endpoint (never sign this proof in browser code).
2. Derive owner status, active membership, active tenant and Supabase issuer/subject from server-verified records, not request fields.
3. Sign RS256 assertions with a protected server-side key and publish/pin a rotation-aware public JWK.
4. Bind assertion issuer, audience, Supabase issuer/subject, NOVA OS tenant ID, role/status, iat/exp and unique JTI exactly to Core's verifier contract.
5. Replace demo-wide Supabase RLS policies before using the project for tenant or operator data.
6. Add contract tests that generate an assertion from the upstream service and verify it through Core's real verifier.

No upstream code, Supabase policies, secrets, or production settings were changed by this audit.
