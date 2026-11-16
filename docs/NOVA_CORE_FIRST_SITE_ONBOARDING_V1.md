# NOVA Core first-site onboarding contract — v1

Status: implemented on the draft branch only. This does not enable production site creation.

## API

Public gateway: `POST /api/v1/tenants/{tenant}/sites`

Private Tenant API: `POST /internal/v1/tenants/{tenant}/sites`

Request headers:
- Cloudflare Access JWT (verified by the gateway)
- Supabase bearer token (verified independently by the private Tenant API)
- `Idempotency-Key` (1–160 characters; restricted identifier syntax)
- `Content-Type: application/json`

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

The new schema migration is `0027_tenant_asset_registration.sql`, after the site-creation migration `0026`. It adds append-only event and immutable idempotency ledgers with active-owner and exact tenant/site/asset guards.
