# Site Lifecycle Durable Command API Contract

## Status and scope

Design-only contract for the runtime cutover that follows the additive command ledger in migration 0042. This document does not add routes, change migrations, or alter the existing lifecycle action. The existing event/application ledger remains the authority for a completed site status transition.

The implementation must be delivered in coordinated Core and NOVA OS changes. Do not enable the new API until all Core integration tests and the matching browser contract tests pass.

## Existing contract and gap

The current private routes are:

- `POST /internal/v1/tenants/{tenant}/sites/{site}/lifecycle-actions`
- `GET /internal/v1/tenants/{tenant}/sites/{site}/lifecycle-events`

The action handler computes an intent digest, checks active tenant/admin membership and the exact site read grant, then inserts an immutable lifecycle event. A lost response can be recovered only when the caller still has the original idempotency key. NOVA OS currently keeps that key in component memory, so a full reload can lose the recovery handle.

Migration 0042 adds a durable command row and append-only command events, but the existing HTTP route does not create or consume those rows. The migration is therefore not yet an end-to-end recovery feature.

## Required command protocol

Use exact tenant/site-scoped routes and strict method matching. The concrete route names may be finalized during implementation, but the semantics below are mandatory.

### 1. Prepare or recover

Input is limited to the action and reason. Actor identity is derived only from the verified gateway envelope; never accept an actor, role, tenant, or grant assertion from the request body.

The service must:

1. Validate exact tenant/site IDs, action, reason and bounded JSON body.
2. Verify the gateway signature, one-use transport request nonce, verified Access issuer/audience/subject and linked identity using the existing private Worker boundary.
3. Recheck active tenant, active owner/admin membership, exact site read grant, and current expected site status.
4. Compute the canonical intent digest server-side over protocol version, tenant, site, verified actor, action and reason.
5. Return the existing pending command for an exact same-actor/same-intent retry; never create a second command for that intent.
6. Return a bounded conflict response when a different pending command exists for the site. Do not silently replace, reject, or mutate it.
7. Generate the durable command ID on the server. The ID is a lookup identifier, not a bearer credential.
8. Return only public command fields. Never return the request digest, signature, token, or internal actor proof.

The database unique pending-command index remains the final concurrency guard. Application-level prechecks are not sufficient.

### 2. Read/recover

An authorized active owner/admin with the exact site read grant may inspect the current pending command and bounded append-only command history for that exact site. The service must recheck authorization on every request.

The response must distinguish pending, applied and rejected. If applied, it must include the authoritative lifecycle event ID and resulting status, read from the event/application ledger. A pending command must not be described as completed merely because an apply request was sent.

A retry after a lost prepare response must be recoverable by repeating the exact prepare intent or by reading the site's pending command. A retry after a lost apply response must resolve from the durable command status and authoritative lifecycle event, not by creating a new command.

### 3. Apply

Apply is a POST-only operation scoped to exact tenant, site and command ID. It must:

1. Derive the current actor from the verified gateway envelope.
2. Recheck active tenant, active owner/admin membership and exact site read grant.
3. Require that the command is pending and that its immutable tenant, site, original actor, action and expected status match.
4. Require the original command actor to remain active and authorized for the transition. Do not allow a different administrator to impersonate the original actor.
5. Insert the lifecycle event with its exact `command_id`, matching reason, action, expected status and digest.
6. Let the database triggers apply the site status, create the application record, terminalize the command and append the terminal command event atomically.
7. Return the durable result. If the response is lost, read/recover must return the already-applied event; repeating apply must be idempotent and must not create a second lifecycle event.

No handler may update site status directly or terminalize a command outside the guarded event insertion path.

## Important schema gap: abandoned commands

Migration 0042 binds the command to its original actor. Its command-event rows also use the command's original actor, and the update guard allows pending-to-rejected but does not record a distinct resolver identity. If the original actor is removed, suspended, or loses the site grant while a command is pending, the command may permanently block the site's one-pending-command constraint. Allowing another administrator to apply the original actor's intent would violate actor binding.

Before runtime cutover, add a separately reviewed schema/service capability for **administrative rejection only**:

- A currently active tenant owner/admin with the exact site read grant may reject an abandoned pending command when its original actor is no longer authorized, or when the expected site state makes the command permanently inapplicable.
- The rejection must carry a bounded machine-readable reason code and a human explanation, and must record the resolving administrator as a distinct actor in the append-only command history.
- Rejection must never change site status or create a lifecycle application.
- A command may not be rejected merely to clear a competing valid command; the rejection preconditions must be checked in the same transaction as terminalization.
- A rejected command is immutable and cannot be reopened. A new command requires a fresh explicit operator action after the site status/history has been reviewed.
- If no authorized administrator remains, do not add a service bypass. Escalation is an operational/manual governance process outside this API.

The schema change must preserve the original command actor and digest as immutable facts while adding a separately attributable resolver. Do not overload the existing `actor_subject` column with two meanings.

## Security and response rules

- Keep the signed gateway-to-private-Worker envelope as the only source of verified actor identity.
- Keep transport request nonce separate from durable command identity and intent digest.
- Bind every operation to exact tenant and site; never trust path/body mismatches.
- Reject unknown body keys, query strings and fragments where the route matcher currently rejects them.
- Enforce POST for prepare/apply/reject and GET for read/recover; do not create method aliases.
- Recheck tenant, membership, grant and site state on every state-changing request.
- Keep command and lifecycle history append-only and bounded (maximum 100 returned rows).
- Do not expose raw digest, internal HMAC headers, Supabase tokens, or credentials.
- Preserve generic not-found behavior where revealing cross-tenant resource existence would leak information.
- Keep response bodies bounded and validate them in NOVA OS before updating UI state.

## Required test matrix

### Prepare/recover
- First prepare creates exactly one pending command and one prepared event.
- Exact repeated prepare returns the same command ID and does not append a second prepared event.
- Same site with different actor or different intent conflicts while a command is pending.
- Two concurrent prepares cannot create two pending commands.
- Inactive tenant, inactive membership, non-admin role, missing exact site grant, wrong expected status and unknown body fields are rejected.
- Path tenant/site mismatch, unverified actor and caller-supplied actor fields are rejected.

### Apply/recovery
- Apply inserts exactly one event with the exact command ID; status, application, command terminal state and command event are atomic.
- Simulate a lost HTTP response after commit; read/recover returns applied plus the authoritative event.
- Repeated apply returns the same terminal result without a second event.
- Wrong actor, wrong tenant/site/command ID, changed intent, stale expected status and revoked authorization cannot apply.
- Two concurrent applies yield one applied result and no duplicate event.
- Failure during application rolls back the event, site status, application, command terminalization and terminal command event together.

### Abandoned command resolution
- Original actor loses membership or site grant: original actor cannot apply.
- Another active admin can reject only under explicit abandoned/inapplicable preconditions and is recorded as resolver.
- Resolver cannot apply on behalf of the original actor.
- Rejected command remains immutable and frees the one-pending-command slot.
- No authorized admin means no automated bypass.

### Route and browser contract
- Exact path/method allowlists and bounded request/response parsing.
- No actor or authorization fields accepted from browser body.
- No secret, token, digest or bearer credential persisted in browser storage.
- Full reload and second-device recovery resolve the same command.
- UI distinguishes pending, applied, rejected and conflict; it never creates a replacement command while an unresolved command exists.
- Site status and append-only event history remain the final authority displayed to the operator.

## Release gates

1. Implement and review the resolver schema extension before runtime cutover.
2. Implement Core service functions and private Worker routes with exact gateway allowlists.
3. Add gateway integration tests against disposable D1 with ordered migrations.
4. Add NOVA OS client validators, reload recovery UI and browser contract tests.
5. Verify legacy route cannot bypass the command ledger once all supported clients have migrated; retire it with an explicit 410 only in the coordinated cutover.
6. Obtain independent security review and perform authorized staging E2E, including reload/lost-response and authorization-revocation scenarios.
7. Only then consider production migration/deployment under a separately approved release plan.

No staging or production action, secrets, tenant/site records, customer data, paid service or deployment is authorized by this design document.
