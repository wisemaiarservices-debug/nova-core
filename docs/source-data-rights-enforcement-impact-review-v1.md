# Source data-rights enforcement impact review v1

**Review basis:** NOVA Core PR #311, exact source head `d849388909717ae248cb38991935017f72c9c94e`.

**Scope:** repository source review and the read-only aggregate inventory executed by CI against disposable local D1. This is not a production or remote-database inventory.

## Exact-head validation

Workflow [44963409768](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44963409768) passed all three jobs:
- API and ingestion security tests
- Research/raster tests
- Tenant Worker tests, including ordered migrations through 0063, read-only inventory, evidence/rights D1 regressions, capability lifecycle, gateway integration and observation commit guards

## Inventory result from disposable local D1

The inventory returned:
- 3 approved capabilities classified as `legacy_or_malformed_reference` for `data_rights_ref`.
- All 3 approved capabilities classified as `unresolved` for the rights/evidence governance chain.
- All 3 approved capabilities classified as `no_resolvable_rights_declaration` in the approved-capability cutover query.

These are synthetic CI fixture counts only. They must not be interpreted as production tenant counts or evidence about any remote database.

## Source-level enforcement gap

At this source head:
- The capability review guard in migration 0049 checks an independent active reviewer and valid lifecycle state, but does not resolve `data_rights_ref` to a rights declaration.
- The observation insert guard in migration 0055 validates the capability, source, site, asset, metadata, quality flags and calibration chain, but does not recheck current rights approval or supporting evidence verification.
- Migrations 0060–0063 establish immutable evidence/rights records, lifecycle events, idempotency, revocation handling and effective-date checks during rights approval. They do not close the capability-approval or observation-insert enforcement gaps.

## Required enforcement contract for a future additive migration

A future D1 cutover should fail closed for **new capability approvals** and **new observation inserts** unless all of the following hold at the write boundary:

1. `source_capabilities.data_rights_ref` resolves to exactly one `source_data_rights_declarations.id`.
2. Rights declaration tenant, site and source exactly match the capability; asset scope must be explicitly defined and exact (no cross-asset reuse).
3. The declaration's latest lifecycle event is `approved`; its effective window includes the approval/write instant.
4. Its supporting evidence ID and SHA-256 resolve to the exact immutable document under the same tenant/site/source scope.
5. The evidence's latest lifecycle event is `verified`; its effective window includes the approval/write instant.
6. The permitted-purpose array explicitly contains both `measurement_ingestion` and `storage`. Analytics and model-training remain separate purposes; neither is implied.
7. Capability `evidence_ref` must have one canonical interpretation and be consistent with the supporting evidence referenced by the rights declaration. No arbitrary URL or unresolved legacy string should silently satisfy the contract.

At observation insertion, repeat the current rights/evidence lifecycle and effective-window checks rather than relying on an earlier capability approval. This ensures a later rights revocation or evidence withdrawal blocks subsequent observation writes. Historical observations should remain immutable; no retroactive deletion or rewriting is implied.

## Cutover constraints

- Do not silently grandfather unresolved legacy references for new writes.
- Do not rewrite or revoke historical approved capabilities based only on this synthetic inventory.
- Before enabling the migration on any real environment, obtain an explicitly authorized, read-only aggregate inventory of that environment and a product/legal decision on historical records and asset-scope semantics.
- Convert or replace synthetic and legitimate legacy fixtures with complete evidence/rights chains before enabling the new positive-path tests.
- Add D1 tests for missing/unresolved references, wrong tenant/site/source/asset, wrong digest, absent purpose, pending/rejected/revoked rights, rejected/revoked/unverified evidence, future/expired windows, exact positive path, rights revoked after approval, evidence withdrawn after approval, and idempotent reviewer event retries.
- Apply only to disposable local D1 in CI until independent review, staging provisioning and explicit deployment authorization are separately satisfied.

## Status

This document records the exact-head audit and specifies the enforcement contract. It makes no runtime/schema change and does not authorize a remote migration, deployment, merge, or data operation.
