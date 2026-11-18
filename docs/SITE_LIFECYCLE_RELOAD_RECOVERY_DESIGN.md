# Site lifecycle reload recovery — design and release gate

**Status:** proposal only; no runtime, schema, gateway, browser, or deployment changes.
**Baseline:** NOVA Core PR #266, exact candidate `e157555927f85a30a04366c4317a32b00b0fa42c`.
**Related browser work:** NOVA OS PR #65 adds an explicit history-review acknowledgement, but does not provide durable operation recovery.

## 1. Problem statement

The current lifecycle action uses a browser-generated `Idempotency-Key`. Core migration 0040 stores that key with the immutable lifecycle event and enforces uniqueness over `(tenant_id, actor_subject, site_id, idempotency_key)`. Core also stores a server-computed request digest, and exact retries return the original event while changed intent conflicts.

This is sound while the browser retains the key. NOVA OS intentionally keeps it in component memory and does not write it to local or session storage. A full reload therefore loses the key. The existing lifecycle-history read exposes event IDs, request IDs, timestamps and outcomes, but does not provide a durable way to resolve an uncertain request that may still be in flight or whose response was lost.

The UI must not invent a new key and blindly submit another transition.

## 2. Design objective

Allow an authorized operator to resolve an uncertain lifecycle command after reload or on another device, without:
- storing credentials or bearer secrets in browser storage;
- weakening actor, tenant, site, membership or exact site-read-grant checks;
- permitting a second transition while the first is unresolved;
- turning the append-only event ledger into a mutable job table;
- treating a browser acknowledgement as proof that the operator read the history.

## 3. Recommended server-side model

Introduce a separate durable lifecycle-command ledger, distinct from the immutable event and event-application ledgers.

Conceptual record:
- server-generated command ID;
- tenant ID and site ID;
- actor subject derived exclusively from the verified Access gateway envelope;
- requested action and canonical request digest;
- expected previous site status;
- lifecycle state (at minimum pending, applied, rejected/expired);
- created/updated timestamps;
- optional terminal event ID;
- unique active-command constraint for the tenant/site, with actor scoping retained for read authorization.

The command row is not itself authority to change site status. The existing migration-0040 event insertion guards, exact status compare, one-time application row and append-only protections remain the only mechanism that applies the transition. A successful command must atomically reference the exact lifecycle event that consumed it. Terminal command records should be immutable or append-only through a dedicated transition/event ledger.

### Why a separate command ledger

The event ledger records completed facts. It cannot represent an action that was accepted but whose event has not yet been committed. Reusing event rows for pending work would weaken their meaning and make audit interpretation ambiguous. A command ledger gives the server a durable recovery handle without changing the meaning of lifecycle events.

## 4. Recovery protocol

1. **Prepare:** an authenticated owner/admin submits a transition intent. Core validates active tenant, active membership, exact site read grant, supported status transition and canonical digest. Core creates or returns the single unresolved command for that site. A competing unresolved command returns a conflict and the existing command reference; it never silently creates a second command.
2. **Apply:** Core rechecks authorization and current site status in the same transaction that creates the lifecycle event, consumes the event and terminalizes the command. Existing event and application triggers remain authoritative.
3. **Recover:** after reload, the browser calls a bounded read endpoint scoped to the exact tenant/site. Core derives actor from the verified gateway envelope and returns only commands visible to that actor under current authorization. A command may be read even if the site is now inactive, so an already-started transition can be resolved; this does not permit a new command on an inactive site.
4. **Resolve:** if the command is applied, return its exact terminal event and current site status. If pending, return a safe retry/poll instruction and the same command ID. If rejected/expired, return a stable reason and require a fresh explicit operator action after a new status/history read.
5. **Reauthorize:** every recovery/read/apply request rechecks active tenant, active owner/admin membership and exact site read grant. Revocation must deny further access and prevent application where policy requires current authorization.

The browser never needs to reconstruct or persist the original idempotency key. It can recover by the exact tenant/site context and server-held unresolved command. It must not create a replacement command while one is unresolved.

## 5. Concurrency and failure requirements

- Two simultaneous prepare requests for one site produce one command and one stable command ID.
- Same command ID + same canonical intent is an exact replay.
- Same command ID + changed actor, tenant, site, action, expected status or reason conflicts.
- Concurrent apply attempts create at most one event and one application row.
- A stale command cannot apply after the site's status has changed; the expected previous status is checked transactionally.
- A lost HTTP response after commit is recoverable by the scoped recovery read.
- A process crash between prepare and apply leaves a visible pending command that can be safely resumed or terminalized under a bounded lease/state transition.
- A process crash during apply cannot leave a command marked applied without its event and application row, or vice versa.
- Never infer success from a timeout, browser notice, or optimistic UI state.
- Keep lifecycle action routes POST-only and recovery/history routes GET-only, with exact path/method allowlists and bounded response bodies.
- Keep transport request IDs separate from durable command identity.
- Do not expose internal request digests, actor secrets, Access tokens, or internal authorization material in public responses.

## 6. Site deactivation interaction

The current Core candidate allows an existing assessment operation to terminate as `not_assessed` after site deactivation, while new assessment reservations and lease renewals remain active-site only. Lifecycle command recovery must preserve that behavior.

A pending deactivation command must not be bypassed by a second transition. An inactive site must not accept a new reactivation command until the prior deactivation command is terminal and its event/status are reconciled. Reactivation restores site status only; it does not restore child assets, sources, grants, calibrations, mappings or policies.

## 7. Required tests before implementation approval

### Database/migration
- ordered migrations from the supported baseline;
- command ledger append-only/state-transition guards;
- unique unresolved-command constraint under concurrent inserts;
- exact actor/tenant/site/action/digest binding;
- command/event/application atomicity and rollback;
- status race and stale expected-status rejection;
- unauthorized membership, tenant, and site-grant rejection;
- no direct site-status update bypass;
- inactive-site recovery of an existing command without new command creation.

### Worker/gateway HTTP
- verified Access actor only; caller-supplied actor ignored/rejected;
- exact method/path allowlists, malformed IDs, query/hash/trailing path rejection;
- duplicate prepare returns same command;
- concurrent apply/replay returns one event;
- lost-response simulation followed by reload recovery;
- role/grant/membership revocation between prepare, recover and apply;
- bounded history/recovery response and no internal digest leakage;
- HMAC binding of method, exact path, actor/issuer/audience, request nonce, body digest and durable command ID.

### NOVA OS
- reload and second-device recovery with no browser storage;
- stale tenant/site request cancellation;
- no second action while a command is unresolved;
- explicit review of exact current site status and newest event before a new command;
- distinguish pending, applied, rejected and inaccessible states;
- no optimistic success before Core confirms terminal state.

## 8. Migration and rollout strategy

1. Implement and test the new command ledger in a separate draft Core PR stacked on the reviewed #266 candidate.
2. Add exact gateway/private Worker contracts and disposable-D1 integration tests.
3. Add NOVA OS client validators and UI in a separate draft PR; no production or customer data.
4. Run independent cross-repository security review and coordinated staging E2E only after explicit staging approval and verified free-only prerequisites.
5. Do not merge, migrate staging/production, deploy, provision tenants or change secrets/configuration as part of this design document.

## 9. Open design decisions

- Define the command lease/recovery ownership model. Prefer a short server-side lease with monotonically increasing fencing version if processing is asynchronous; do not use client clocks as authority.
- Decide whether a terminal rejected command can be retried by the same command ID (preferred only for explicitly transient, deterministic reasons) or must require a new operator-confirmed command.
- Define retention and audit export requirements without deleting immutable lifecycle events.
- Confirm D1 transaction semantics and unique-index strategy with executable concurrency tests before selecting final schema.
- Ensure the active-command constraint does not block legitimate recovery after a command has terminalized.

## 10. Current truth

Core #266 is a draft candidate with exact-head CI previously reported passing 3/3. NOVA OS #64 is a draft browser candidate with client/unit/build validation previously reported passing. NOVA OS #65 is a draft human-factors guard with exact-head CI run 44417321590 passing. There is no independent security sign-off, live staging E2E, production migration or deployment.