# Assessment Operation Recovery V1 — Core Schema Review Addendum

This addendum records findings from the current consolidated candidate branch `integration/core-governed-ingestion-assessment-http-v1` at review time. It refines PR #240's proposal; it does not change runtime code.

## 1. Confirmed current implementation constraints

1. Migration `0015_measurement_quality_engine.sql` creates `measurement_quality_assessments` with immutable update/delete triggers and `UNIQUE(tenant_id, request_id)`.
2. The assessment row already stores the observation, site, status, reason, mapping, calibration, policy, method version and original request key.
3. `assessMeasurementQuality` accepts the operation key as `requestId`, looks up an existing assessment by tenant + request key, and rejects reuse for another observation. This makes same-key replay work only while the caller retains the key.
4. The current assessment route checks active membership and the exact site read grant before calling the service. It does not persist the initiating Access subject on the assessment row.
5. The current replay lookup is tenant/request-key scoped, not actor scoped. A new operation-recovery API must not reuse that lookup as its authorization boundary.
6. The final passed/failed assessment insert is guarded by exact current observation, source, mapping, calibration and policy predicates. Migration `0035` independently guards new observation insertion against source revocation.
7. The existing route separates one-time transport nonce from the signed `x-nova-idempotency-key`. Every HTTP attempt needs a fresh transport nonce.
8. The current assessment insert and assessment result persistence are service-level writes; no durable pending-operation row exists today.

## 2. Proposed migration shape

The following is a design target, not executable migration SQL. Names and constraints must be validated against the exact SQLite/D1 version and current migration chain before coding.

### measurement_assessment_operations

Required columns:
- `operation_id` — Core-generated opaque UUID, primary key; also used as the assessment `request_id` so the existing unique constraint remains the final duplicate barrier.
- `tenant_id`, `site_id`, `observation_id` — immutable exact scope.
- `actor_subject` — verified Access subject from the authenticated gateway envelope, never from the request body.
- `request_digest` — SHA-256 digest of canonical operation identity and immutable inputs.
- `state` — reserved, running, completed, not_assessed, failed.
- `assessment_id` — nullable FK to the exact assessment produced by this operation.
- `predecessor_operation_id` — nullable reference used only for explicit re-assessment.
- `lease_version`, `lease_expires_at`, `attempt_count` — bounded worker takeover.
- server timestamps and a bounded terminal error code (no raw exception or secret).

Constraints:
- Composite FK to `observations(id, tenant_id, site_id)`.
- Composite FK from `(assessment_id, tenant_id, site_id, observation_id)` to a matching unique key on `measurement_quality_assessments`; add the unique parent index only if required and migration-safe.
- Unique `(tenant_id, predecessor_operation_id)` when predecessor is non-null: at most one explicit successor per completed operation.
- Partial unique index for one unresolved operation per `(tenant_id, actor_subject, observation_id)` while state is reserved or running.
- State and immutable-scope triggers; operation event ledger with immutable insert-only events.
- Operation rows are not deleted by normal retention. Assessment and audit history remain immutable.

The assessment row's `request_id` must equal `operation_id`. This allows the existing unique constraint to remain an independent duplicate barrier and lets the operation FK prove which immutable assessment was produced.

## 3. D1 atomicity design requirement

Do not implement the state machine as unrelated sequential writes. Use a D1 atomic batch for the state transition and assessment insert, with conditional SQL:

1. Validate and load the operation under exact tenant, actor, observation and current grants.
2. Claim or renew a bounded lease using a conditional update on operation ID, state and lease version. A losing worker must not proceed.
3. Re-run all current governance predicates at final assessment insertion, preserving the current final-write guard.
4. Insert the assessment with `request_id = operation_id`, using the existing uniqueness constraint.
5. In the same atomic batch, complete the operation only if the expected assessment row exists and is exactly scoped to the operation; append the immutable operation event conditionally.
6. Inspect every batch result. If the final governance insert writes zero rows, persist a `not_assessed` outcome only through a separately specified atomic path that does not bypass governance. If the batch aborts, recover by resolving the durable operation and existing assessment row; never mint a replacement operation.
7. A concurrent execution loser reads and returns the winner only after re-authorizing the operation and verifying the exact digest/scope/actor binding.

The existing `not_assessed` results are durable assessment records too. Their creation must also be atomic with operation completion, so a lost response can always resolve to the original not_assessed result. Do not classify transient storage failure as a completed not_assessed assessment.

If D1 batch semantics or trigger ordering cannot provide the required invariant, stop and design a durable outbox/reconciliation protocol before implementation. Do not approximate atomicity with mocked `meta.changes` tests.

## 4. Actor binding and compatibility

- New operation resolution and replay are scoped to verified Access subject + tenant + observation.
- Operation ID is an identifier, never a bearer token.
- Existing assessment rows cannot be retroactively attributed to an actor. They remain readable only through current existing resource authorization; do not invent historical actor attribution.
- New assessment creation must go through the operation ledger once enabled. Avoid leaving an alternate route that writes assessments without an operation record.
- Existing assessment request keys must not collide with Core-generated operation UUIDs. Use an explicit migration/version boundary and reject collisions safely.
- Replays of completed operations return the original immutable assessment; they do not recompute against today's governance state.
- An explicit new assessment is a successor operation with a compare-and-swap predecessor. Automatic retries never create successors.

## 5. Route authorization and gateway contract

Proposed private endpoints should be narrow:
- resolve actor's operation for exact tenant + observation;
- reserve or reuse an operation;
- execute/resume an operation;
- read a specific operation.

For every endpoint:
- Verify the HMAC envelope, fresh transport nonce, Access subject, issuer/audience and the existing dual-identity binding as applicable.
- Recheck active tenant membership and exact site/observation read grant.
- Bind actor subject from the verified envelope, never a caller field.
- For an operation ID lookup, require the operation row to match tenant, actor, site and observation; return a non-enumerating not-found response otherwise.
- Check current grants before returning even a completed operation result.
- Never trust a tenant ID, actor, site, observation, operation state, assessment ID or digest copied from browser storage.

The gateway must sign the new operation endpoint path, body digest, transport nonce and any stable idempotency data under the existing canonical HMAC envelope. Each attempt uses a fresh transport nonce. No secrets or credentials are added to browser storage.

## 6. Required additional tests from schema review

- Operation actor is derived from the verified envelope; caller-supplied actor fields are rejected.
- Same tenant/observation/key cannot be replayed by another actor through the new operation routes.
- A user with observation read access cannot read another actor's pending operation.
- Assessment insert and operation completion either both commit or neither commits.
- A completed assessment with a lost HTTP response resolves to the exact same assessment ID after reload.
- A not_assessed assessment with a lost HTTP response resolves to the exact same record.
- Concurrent lease claims have one winner; expired lease takeover cannot overwrite a newer lease version.
- The operation assessment FK rejects a result for a different tenant/site/observation.
- State transition triggers reject completed -> running, scope mutation, actor mutation, and duplicate successor.
- No legacy assessment-write route bypasses the operation ledger after cutover.
- Migration rehearsal starts from the exact existing 0035 ledger and verifies foreign keys, indexes, triggers, rollback/failure behavior and immutable legacy rows.

## 7. Decision

Proceed to implementation only after the operation schema and D1 batch transaction are reviewed against the current migration chain and Worker runtime. The design remains documentation-only until then. No staging, production, secrets, tenant provisioning, or paid resources are authorized by this addendum.
