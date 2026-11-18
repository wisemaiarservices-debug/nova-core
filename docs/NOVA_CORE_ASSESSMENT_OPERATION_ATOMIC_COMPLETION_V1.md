# NOVA Core — Atomic Measurement Assessment Operation Completion V1

**Status:** design proposal; not runtime authorization  
**Parent implementation:** assessment operation ledger PRs #241–#245  
**Scope:** Core tenant API / D1 transaction boundary

## 1. Objective

Make one assessment operation produce exactly one durable, recoverable outcome. The assessment row, operation terminal state, and append-only operation event must commit together. A timeout or lost HTTP response must be recoverable by reading the same actor-scoped operation, never by creating another assessment.

This design does not assert that an assessment is scientifically true. Existing measurement-quality rules remain unchanged: only exact verified observations, currently verified sources, exact verified sensor/source mappings, effective verified calibrations, and exact approved policies may produce passed/failed outcomes. A changed or missing governance predicate produces a durable `not_assessed` outcome.

## 2. Existing schema and runtime constraints

- Migration `0036_measurement_assessment_operations.sql` adds actor-scoped operation identity, exact tenant/site/observation foreign keys, assessment linkage, predecessor linkage, lease version, and append-only event history.
- Migration `0037_measurement_assessment_operation_lease_fencing.sql` binds a running lease to a unique `lease_request_id`, requires one-step lease-version advancement, and requires lease events to match the current lease fence.
- `measurement_quality_assessments` has a unique `(tenant_id, request_id)` key. The operation ID must be the assessment `request_id` so a single operation cannot create multiple assessment rows.
- The current `assessMeasurementQuality` service writes its assessment row independently. It must not be called as-is by the new operation completion path because that would create a window where the result exists but the operation remains running.
- Existing protected assessment HTTP route remains unchanged until the new route can guarantee that every new operation-backed assessment uses this transaction. No partial route cutover.

## 3. Trusted completion context

The completion function accepts only server-derived context:

- tenant ID, site ID, observation ID and actor subject from the verified gateway envelope and authorized route context;
- operation ID, lease version, lease request ID and exact lease expiry from the durable operation row / claim response;
- a fresh one-time transport request ID for the completion attempt;
- server-generated current timestamp.

Never accept actor subject, tenant scope, operation ID, lease token, result status, or governance evidence as authoritative caller JSON. The raw client idempotency token is not stored. The server-generated operation ID is the durable assessment request key.

Before evaluation and again at the write boundary, require active tenant membership, active tenant/site, and the exact site read grant. The operation row must match the same tenant/site/observation/actor and be `running`; its lease version, request ID and expiry must match exactly and remain unexpired.

## 4. Separate evaluation from persistence

Refactor measurement quality into two layers:

1. **Evaluator:** read-only deterministic evaluation that returns a bounded internal decision object:
   - status: `passed`, `failed`, or `not_assessed`;
   - reason code;
   - exact mapping, calibration and policy IDs plus their values needed for the final write guard;
   - observed value/unit and method version.
2. **Atomic persistence:** accepts only that internal evaluation object plus trusted operation context and constructs prepared SQL statements. It owns all assessment inserts and operation transitions.

Do not expose an HTTP endpoint that accepts an evaluation object. Do not duplicate the current governance logic in a second evaluator. Preserve the existing route by keeping its current persistence adapter until the operation-backed route is fully validated; share the read-only evaluator between both paths only after regression parity is proven.

## 5. D1 batch transaction

Use one D1 `batch()` call. All statements must be prepared before execution, run in order, and be scoped to the same exact operation. D1 batch transaction semantics must be verified against the actual Worker/D1 runtime.

### Statement A — attempt the governed passed/failed insert

For evaluator status `passed` or `failed`, insert the immutable assessment row with `request_id = operation_id`. Preserve the existing exact write-time predicates for observation, source, mapping, calibration and policy, including current latest verified lifecycle events and exact tenant/site/asset/parameter/unit/effective-period matching.

Add an `EXISTS` predicate for the current operation lease and active actor authorization. If any governance predicate or lease predicate no longer holds, this insert affects zero rows. Never weaken or omit the existing governance gate.

### Statement B — durable not-assessed fallback

If Statement A did not insert a row, insert exactly one `not_assessed` assessment with reason `governance_state_changed_before_assessment` when the evaluator originally proposed passed/failed. If the evaluator already returned `not_assessed`, insert its exact bounded reason instead.

The fallback insert must itself require the same still-running operation, exact lease fence, active membership/site and exact site read grant. It must include `NOT EXISTS` for an assessment with this tenant + operation ID, so it cannot overwrite or duplicate a winner. If the lease is no longer valid, the fallback must insert nothing.

### Statement C — terminalize the operation

Update exactly one operation row only when the immutable assessment row exists with:
- same tenant, site, observation and operation ID;
- `request_id = operation_id`;
- matching assessment ID and status;
- exact current running lease version, request ID and expiry;
- active tenant membership, active site and exact site read grant.

Map assessment status to operation state:
- `passed` or `failed` assessment → operation `completed` (the operation succeeded even if the measurement is outside policy);
- `not_assessed` assessment → operation `not_assessed`.

Set `assessment_id`, `completed_at`, and `updated_at`; clear `lease_expires_at` and `lease_request_id`. Do not increment the lease version on terminalization. This matches the database lease-fence trigger.

### Statement D — append the terminal event

Insert exactly one immutable event selected from the just-terminalized operation and linked assessment:
- `completed`: `running → completed`, event type `completed`;
- `not_assessed`: `running → not_assessed`, event type `not_assessed`.

Use a fresh server-generated event ID and the fresh completion transport request ID. Existing event-chain triggers must validate the prior state and current operation state.

The event insert must be a statement in the same D1 batch, not a later best-effort write. A trigger rejection must abort the batch. A zero-row result must be treated as a transaction invariant violation, not success.

### Transaction invariant

A successful batch must yield exactly one assessment insert, one operation terminalization, and one terminal event. If any statement errors, the batch must roll back all writes. A zero-row assessment insert caused by changed governance must select the not-assessed fallback; a zero-row insert caused by a stale/expired/revoked operation must not produce an assessment or terminal event.

Because SQLite/D1 does not automatically roll back a transaction merely because a statement affects zero rows, every later statement must be gated by the exact rows created/updated by the earlier statement. Do not rely only on inspecting `meta.changes` after the batch returns.

## 6. Retry and lost-response behavior

- The operation ID is stable across retries and is the assessment `request_id`.
- Each HTTP attempt uses a fresh one-time transport nonce; the operation lease token remains distinct.
- If completion succeeds but the response is lost, actor-scoped read returns the terminal operation and linked immutable assessment.
- A retry against a terminal operation returns the original result; it does not insert a second assessment or successor.
- A stale worker whose lease was recovered or renewed must fail the exact lease compare-and-swap and cannot terminalize.
- A deliberate reassessment is a new explicit successor operation linked to a completed/not-assessed predecessor. It is never an implicit retry.

## 7. Required tests before route wiring

### Real D1 transaction tests
- successful passed, failed and not-assessed completion;
- governance revoked between evaluation and final insert → durable not-assessed fallback;
- lease expires between evaluation and final write → no assessment, no terminal event, operation remains recoverable;
- actor membership or site grant revoked before write → no assessment and no terminal event;
- event trigger rejection → assessment insert and operation update roll back;
- assessment insert conflict / same operation replay → original row returned, no duplicate event;
- two simultaneous completions for the same operation → exactly one terminal result and event;
- stale worker versus recovered/renewed lease → stale completion writes nothing;
- transaction response lost after commit → actor-scoped read reconstructs exact result;
- exact cross-tenant/site/observation/actor isolation and composite FK enforcement.

### Evaluator parity tests
Run the existing measurement-quality suite against both legacy and operation-backed adapters. Preserve all current reason codes and governance behavior. Include revoked/disabled/unverified source, mapping/calibration/policy revocation, wrong module/site/asset, ambiguous mappings, expired calibration, missing policy, synthetic provenance, and boundary values.

### Route and browser tests
- no caller-supplied actor or result status is trusted;
- operation token survives page reload via server-side operation resolution;
- tenant/observation change aborts stale in-flight requests;
- same operation key is reused after timeout; transport nonce is fresh;
- retry and second-device recovery return the same terminal result;
- old route cannot bypass the ledger after cutover.

## 8. Rollout gates

1. Land the ledger, lease fence, reserve/read, claim and renewal schema/runtime prerequisites in dependency order.
2. Implement evaluator extraction and the atomic persistence adapter behind an unexposed service boundary.
3. Prove rollback, races and lost-response recovery with real disposable D1 and Worker Service Bindings.
4. Add protected HTTP routes only after those tests pass.
5. Update NOVA OS to resolve and poll server-owned operations; no browser storage of raw credentials or lease tokens.
6. Run staging validation using the release runbook. No production migration or deployment until configuration, identity binding, signing keys, D1 migration order, Access policy and rollback plan are independently verified.

## 9. Explicit non-goals

This proposal does not enable production, authorize a migration, create a pilot tenant, claim scientific validation, certify instruments or laboratories, or make AI/model-performance claims. It does not alter historical assessments. It introduces no paid service dependency.
