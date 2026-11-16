# NOVA Core first-site onboarding contract — v1

Status: design contract only. This document does not add a route, migration, site, grant, source, or production capability.

## Current implementation finding

The Tenant API exposes a tenant-scoped site list and site-scoped reads. It has a site-grant mutation route, but no tenant-scoped site-creation route was found in the reviewed private Tenant API route table. The site table is already consumed with the fields `id`, `tenant_id`, `name`, and `status`; test fixtures insert site rows directly. Therefore, first-site creation is currently an operational gap and must not be represented as available in NOVA OS.

The source registry and verification workflows exist separately. Source registration is not the same as site creation, and a newly created site must not automatically create or verify a source.

## Proposed first-site API

Public gateway:

`POST /api/v1/tenants/{tenant}/sites`

Private Tenant API:

`POST /internal/v1/tenants/{tenant}/sites`

The endpoint must be implemented in a future code PR. Until then, clients must not call it or simulate success.

### Authentication and authorization

- Require the existing Cloudflare Access JWT verification and signed gateway-to-private-Worker envelope.
- Require the separately verified Supabase identity where the dual-identity tenant workflow applies.
- Derive the actor exclusively from the verified gateway subject and persisted active tenant membership.
- Require an active tenant and an active `tenant_owner` membership for the first implementation. Tenant admins may be considered later under a separately reviewed policy.
- Do not accept actor, role, tenant owner, tenant ID, site ID, grant subject, or authorization claims from the body.
- Recheck the active owner and tenant inside the D1 mutation transaction; serialize against owner suspension/role change and tenant deactivation.

### Request contract

Accept only:

- `name`: required, trimmed, bounded human-readable site name.

Reject unknown keys, empty names, control characters, oversized values, malformed JSON, query strings, and ambiguous tenant/member state. Generate the site ID server-side. The request must be idempotent, with the idempotency key bound to the verified actor, tenant, and canonical request digest. Same-key/same-request retry returns the original site; conflicting reuse returns 409.

Do not collect or infer coordinates, country, address, site geometry, timezone, crop, soil, water, energy, device, gateway, or sensor configuration in this minimal operation. Those require explicit typed fields, units/CRS, provenance and validation in later workflows.

### Atomic first-site transaction

A successful create must commit together:

1. one active site row under the exact tenant;
2. one immutable site-created audit event;
3. one exact `read` grant for the authenticated creating owner on the new site;
4. one immutable site-grant event for that read grant;
5. one idempotency record bound to the actor, tenant, request digest and site ID.

The transaction must fail closed if any statement or audit write fails. It must not create an operator membership, add any other user's site grants, or grant `create`, `update`, `delete`, `ingest`, or `manage_members` permissions.

### Site lifecycle and audit

Introduce an append-only tenant-scoped site event ledger with at least:

- site ID and tenant ID;
- event type (`created`, later separately governed lifecycle events);
- verified actor subject;
- reason;
- unique request ID;
- server timestamp.

Use database constraints/triggers to enforce tenant/site consistency, matching state for create events, and no event UPDATE/DELETE. Restrict direct table privileges; route mutations must go through the private Tenant API's controlled transaction.

No site archive/delete/reassignment endpoint is included in the first-site operation.

## Separate follow-on workflow: source registration and verification

After site creation:

1. An authorized tenant owner/admin registers a source against the exact tenant and site, with explicit module, provider, source type, display name and provenance metadata. Initial status is `unverified`.
2. A separately assigned site reviewer, independent of the registrant, reviews the source declaration and cited evidence.
3. Verification/rejection/revocation is recorded in an append-only source event ledger. A verified state is not a claim that the physical device, wiring, calibration or data accuracy has been independently proven unless that evidence is specifically checked.
4. Ingestion remains disabled until the source is `verified`, the exact module/source service grant and server-side Cloudflare service identity are configured, and the ingestion Worker validates the authenticated service token and exact source allowlist.
5. Ingestion persists observations as unverified pending their separate observation review. Source verification must not auto-verify observations.

## Required regression coverage before implementation is enabled

- owner creates one site; generated ID is unique and tenant-scoped;
- active admin, operator, analyst, viewer, suspended owner, cross-tenant owner, and unauthenticated caller are denied;
- inactive tenant is denied;
- caller-supplied actor/role/site/tenant IDs and unknown body keys are rejected;
- same idempotency key and same digest replays the same site and receipt; conflicting digest returns 409;
- concurrent same-key requests create exactly one site and one audit event;
- a concurrent owner suspension or tenant deactivation serializes with the create transaction;
- site insert, site-created event, initial owner read grant, grant event and idempotency row roll back together on injected audit failure;
- creator receives only the exact `read` grant; no other member gets access;
- no source, asset, observation, reviewer assignment, ingestion grant, credential or service-token configuration is created;
- cross-tenant site listing and reads remain denied;
- gateway → private Worker → disposable D1 integration validates the actual signed envelope and persisted authority.

## Release boundary

This contract is not an implementation and does not authorize production migration or deployment. Keep NOVA OS's first-site action unavailable until the route, gateway forwarding, migration, audit controls, idempotency, exact-head CI, disposable D1 integration and security review are complete.
