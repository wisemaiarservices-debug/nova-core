# NOVA Core — Assessment Operation Private HTTP Contract V1

Status: design-only; no route or gateway behavior changes.

Parent implementation: PR #249. This contract exposes the durable assessment-operation services only after the route-level identity, transport and retry rules below are implemented and tested.

## 1. Route matrix

All private routes are under `/internal/v1`; public gateway routes use the corresponding `/api/v1` prefix and forward to the private path through the existing signed Service Binding envelope.

| Method | Private route | Purpose |
|---|---|---|
| POST | `/tenants/{tenant}/observations/{observation}/measurement-assessment-operations` | Reserve or recover the actor-scoped operation |
| GET | `/tenants/{tenant}/measurement-assessment-operations/{operation}` | Read operation, terminal result and event history |
| POST | `/tenants/{tenant}/measurement-assessment-operations/{operation}/claim` | Claim a reserved operation or recover an expired lease |
| POST | `/tenants/{tenant}/measurement-assessment-operations/{operation}/renew` | Renew the exact active lease |
| POST | `/tenants/{tenant}/measurement-assessment-operations/{operation}/complete` | Evaluate and persist the terminal assessment |

No caller-supplied actor subject, tenant membership role, site grant, operation state, current time, lease expiry, assessment result or evidence record is trusted.

## 2. Identity and authorization

- Actor identity is derived only from the verified Cloudflare Access subject in the signed gateway envelope.
- The route resolves the exact observation and its stored site before reserving an operation.
- Every route requires an active tenant, active membership for that Access subject, active site and exact site read grant.
- Service methods repeat membership, site and grant checks at the database write boundary.
- Operation ID is an identifier, never a bearer credential. Every read and mutation is tenant- and actor-scoped.
- The gateway's one-time `x-nova-request-id` remains a transport nonce. It is fresh for every HTTP attempt and is not the durable operation ID.

## 3. Request bodies

### Reserve

Body permits only the optional `predecessor_operation_id`; no client-generated operation ID or digest.

The server computes a canonical SHA-256 digest over a versioned structure containing tenant, exact observation and site, verified Access subject, and predecessor ID (including explicit null). The operation service generates the opaque operation UUID. Repeating the same reservation request by the same actor and exact scope resolves to the original operation. A new assessment requires an explicit completed predecessor; the unique-successor rule prevents duplicate successors.

### Read

No body. Return a bounded operation projection and bounded event history. Omit internal request digests and storage-only columns. Do not expose another actor's operation; return the same not-found response used for unknown operations.

### Claim

Empty JSON object only. Server derives `now` and a lease expiry no more than five minutes later. A reserved operation may be claimed; a running operation may only be recovered after its recorded lease expiry. The fresh transport request ID becomes the lease fence token.

### Renew

Body permits only `expected_lease_version`, `expected_lease_request_id`, and `expected_lease_expires_at`. Server derives `now` and a strictly later expiry bounded to five minutes from now. A retry with stale lease fields conflicts; the caller must read the operation to recover the current fence.

### Complete

Body permits only `expected_lease_version` and `expected_lease_request_id`. The current transport request ID becomes `operation_terminal_request_id`; server time becomes `operation_completed_at`. The server invokes the read-only evaluator and the single bound assessment INSERT from PR #249. The insert-time gate decides passed/failed versus not-assessed and the database triggers terminalize and append the event in the same statement.

## 4. Retry and recovery behavior

- Reserve: same actor/scope/canonical digest returns the original operation ID. Different predecessor or scope produces a distinct explicit operation or conflict as appropriate.
- Claim: a lost response is recovered by GET. Do not blindly claim again while a lease is active.
- Renew: if the response is lost, GET returns the current version/token/expiry to the same actor; stale renewal attempts conflict.
- Complete: if the response is lost, GET or a repeated completion call returns the original immutable assessment. Never create a second assessment for the same operation.
- Page reload and second-device recovery use the server-owned operation ID and authorized GET; no localStorage/sessionStorage secret or client-held idempotency key is required.
- Reassessment is always a new explicit successor operation; it is never inferred from a refresh or retry.

## 5. Gateway and private Worker requirements

- Add each route to both exact path matchers and both method allowlists; reject query strings, fragments, unsupported methods and unknown body keys.
- Forward the exact bounded body and fresh transport nonce through the existing HMAC-authenticated gateway envelope. Do not add an unsigned actor or tenant header.
- Ensure the private route checks active membership/site grant before any operation or assessment result lookup.
- Keep internal service routes inaccessible except through the existing private Service Binding and HMAC verification.
- Add exact-origin CORS headers only where browser preflight is needed; no wildcard origins.
- Keep response bodies bounded and avoid exposing lease/database internals beyond the minimal actor-scoped recovery projection.

## 6. Route cutover gate

The existing `measurement-quality-assessment` endpoint remains unchanged until all of the following are true:

1. Reserve/read/claim/renew/complete routes are implemented in both private Worker and gateway.
2. The NOVA OS browser flow uses the server-generated operation ID and can recover after reload and on a second device.
3. Every new assessment write is forced through the operation-bound insert; no legacy bypass remains.
4. Actual local D1 Worker invocation tests cover passed, failed, not-assessed, lost response, concurrent claim/completion, stale lease, source/mapping/calibration/policy revocation, membership/grant revocation, and cross-actor isolation.
5. The route-level HMAC/Access/tenant/site authorization tests and exact-head CI pass.
6. The rollout has an approved staging environment, migrations and secrets configuration. No such environment is assumed by this design.

## 7. Explicit non-goals

This document does not activate routes, change the existing assessment endpoint, deploy a Worker, apply a production migration, create a tenant, or authorize customer-data processing. No paid service or secret is required by the design.
