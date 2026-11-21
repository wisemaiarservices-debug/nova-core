# Source data-rights enforcement and cutover plan

Status: design and impact-inventory plan only. No runtime enforcement is added by this document.

## 1. Current repository finding

At commit `d2f2f146670820a37efb6933647a89875f94657d`:

- Migrations `0060`–`0062` provide immutable source evidence documents, independent evidence review, immutable data-rights declarations, independent rights review/revocation, and scoped idempotency.
- Capability records contain `data_rights_ref` and `evidence_ref`, but the capability review guard in migration `0049` does not resolve either reference to the new registries.
- Observation insert guard `0055` rechecks capability approval, source/site/asset scope, quality flags, freshness and calibration. It does not query `source_data_rights_declarations`, `source_data_rights_events`, or `source_evidence_events`.
- Migration `0060` explicitly states that it does not alter capability approval or observation ingestion.

Therefore the evidence/rights registry is operational at its own API and D1 boundary, but it is not yet an enforcement dependency for capability approval or observation insertion. Do not describe this branch as enforcing data rights at those two boundaries.

## 2. Required reference contract

Before writing a migration, define and validate a canonical reference contract:

- `data_rights_ref` must resolve to exactly one `source_data_rights_declarations.id` in the same tenant, site and source scope. The reference must be an opaque registry ID, not an arbitrary URL or caller-supplied status.
- The declaration must bind to an immutable evidence document and exact SHA-256 digest. The latest evidence lifecycle event must be `verified`.
- The latest rights lifecycle event must be `approved`; `declared`, `rejected` or `revoked` is not sufficient.
- The declaration's effective window must cover the governed operation's relevant timestamp.
- The purpose set must explicitly include the operation being performed. At minimum, measurement ingestion and storage must not be inferred from analytics, publication or model-training permission. Model training must remain separately explicit.
- Tenant/site/source and optional asset scope must match exactly. A tenant-scoped source compatibility policy is a separate unresolved decision; do not weaken the existing site-scoped capability guards in this work.

The capability-level `evidence_ref` also needs a typed relationship to evidence records. Do not assume it is the same document as the rights declaration's supporting evidence until product policy specifies whether measurement-method, device-certificate, permit and data-license evidence are interchangeable or independently required.

## 3. Enforcement points to design and test

### Capability approval

A future D1 guard on `source_capability_events` should require, for a new `approved` event:

1. Exact `data_rights_ref` resolution to one declaration in the capability's tenant/site/source scope.
2. Latest rights event is `approved`.
3. Latest supporting-evidence event is `verified`, with exact document/declaration digest linkage.
4. Required purposes and effective dates are satisfied at approval time.
5. Existing active tenant/site/source/asset and independent-reviewer guards remain unchanged.

Submission, rejection and revocation must retain their existing lifecycle semantics. An approval must not become valid merely because a non-empty string is present in `data_rights_ref`.

### Observation commit

A future extension of `observations_capability_insert_guard` should re-resolve the capability's rights declaration at the D1 insert boundary and require:

1. Exact tenant/site/source and optional asset scope.
2. Latest rights event remains `approved` and latest evidence event remains `verified`.
3. Required ingestion/storage purposes are explicit.
4. The rights effective window covers `NEW.observed_at`.
5. Revoked, rejected, missing, ambiguous, expired or mismatched rights fail closed.

The policy must decide whether approval must have occurred before `observed_at` or whether an explicitly retroactive effective date can authorize earlier measurements. Do not infer this from timestamps or implement a retroactive rule without a documented decision.

Existing observation verification remains a separate human-review state. Rights approval is not measurement verification.

## 4. Read-only impact inventory required before enforcement

Before adding either trigger:

- Count capabilities by `status`, tenant/site/source and reference shape.
- Classify `data_rights_ref` values as registry IDs, legacy fixture/demo references, malformed references or missing.
- Count approved capabilities with no resolvable rights declaration, no approved rights event, revoked evidence, insufficient purposes or expired effective windows.
- Classify `evidence_ref` values independently; do not conflate them with data-rights references.
- Count observations by capability and observed-time range, including historical records whose capability would fail the proposed new rule.
- Identify all write paths and test direct SQL insertion as well as the ingestion Worker path.
- Produce aggregate counts only; do not export document bytes, customer names, tenant secrets or raw customer telemetry into reports.

The inventory must be read-only and must not rewrite or backfill historical records.

## 5. Cutover and test requirements

Only after product-policy decisions and the impact inventory are reviewed:

- Add an additive, ordered D1 migration with explicit trigger replacement and rollback/forward-recovery notes.
- Keep historical observations unchanged. Do not grandfather new writes based on old capability status.
- Add positive D1 cases for active rights/evidence and exact scope.
- Add negative cases for missing, malformed, cross-tenant, cross-site, cross-source, wrong-asset, unapproved, rejected, revoked, expired and insufficient-purpose declarations.
- Add revocation-after-approval cases proving subsequent observations fail while existing observations remain immutable.
- Add exact effective-window boundary cases and the chosen retroactivity rule.
- Add concurrent review/revocation versus observation-insert tests to establish commit-time behavior.
- Run ordered migrations and gateway/Worker integration only against disposable local D1 in CI.
- Require independent review before any remote migration or deployment is considered.

## 6. Explicit non-goals and safety boundary

This plan does not implement or authorize remote D1 migrations, Cloudflare changes, secrets, deployment, merge, customer-data processing, paid resources or changes to tenant-scoped source policy. The PR remains draft. Exact-head CI for the current code is recorded in PR #311; this document is design-only and does not add runtime validation.
