# Tenant site configuration write API

## Route

`POST /api/v1/tenants/{tenant_id}/sites/{site_id}/configurations`

The route is exposed only through the human Cloudflare Access gateway and its private Service Binding to the tenant API. The private tenant Worker remains without a public route.

## Read routes

- `GET /api/v1/tenants/{tenant_id}/sites/{site_id}/configurations` returns the latest 100 immutable versions, newest first.
- `GET /api/v1/tenants/{tenant_id}/sites/{site_id}/configurations/{version}` returns one exact version.

Both reads require an active tenant membership with read capability and an exact site-scoped `read` grant. Cross-tenant and ungranted-site requests return not found. The stored JSON is returned as `configuration`, alongside its digest, schema, version and creation provenance. The route does not infer or expose another site's records.

## Write request

Headers:
- `Cf-Access-Jwt-Assertion`: human Access JWT, verified by the gateway.
- `Idempotency-Key`: required, 1–200 characters from the route's safe identifier alphabet.
- `Content-Type: application/json`.

Body:
- `payload`: canonical NOVA client configuration object.
- `schema_id`: currently only `nova.client-config.v1`.
- `content_sha256`: optional caller-provided digest; if present, it must equal the server-computed canonical payload digest.

The write route tenant and site identifiers must exactly match `payload.tenant.tenant_id` and `payload.site.site_id`. The caller cannot nominate an actor, review state, configuration version, or tenant ownership.

## Authorization and persistence

The tenant API derives the human subject only from the gateway-verified identity envelope. The persistence service requires:
- one active membership in the active route tenant;
- role `tenant_owner` or `tenant_admin`;
- exactly one site-scoped `create` grant for that subject, tenant and route site;
- a structurally and domain-valid configuration envelope.

It writes the idempotency reservation, immutable configuration snapshot, initial `submitted_for_review` lifecycle event, tenant-owned audit event and completed idempotency response in one D1 batch. Site configuration versions are assigned sequentially by the database. Repeating the same key and canonical payload returns the original completed result; reusing the key for a different payload returns conflict.

## Status and limitations

A successful response means the configuration was stored as an immutable version and submitted for review. It does **not** mean the configuration was approved, commissioned, calibrated, safe, scientifically suitable, or operationally active. This route does not apply the configuration to devices or alter model parameters.

Unknown client-specific fields remain subject to the versioned configuration schema and domain validator. A valid structural envelope does not verify equipment certificates, sensor calibration, legal permits, engineering calculations, field installation or telemetry connectivity.

## Local validation

CI uses disposable local D1, synthetic tenant/site fixtures and the actual local Access gateway/private Worker Service Binding. The integration sequence verifies create (v1), exact idempotent replay and conflicting payload rejection. No remote D1 migration, production deployment, customer data or paid service is part of this change.
