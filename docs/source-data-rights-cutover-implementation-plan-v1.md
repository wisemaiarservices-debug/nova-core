# Source rights cutover implementation plan v1

**Basis:** PR #311 head `69e224e4a29d1999a76abbaeeebacdae83822d61`. This is a source-level plan; no runtime change is made here.

## Verified CI

Workflow [44964370512](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44964370512) passed all three jobs. The Tenant Worker job applied ordered migrations through 0063 to disposable local D1 and passed the read-only inventory, evidence/rights tests, capability lifecycle tests, gateway integration and observation commit-guard tests.

## Exact schema relationships

The existing schema supports a fail-closed additive guard without changing the rights registry:
- `source_capabilities.data_rights_ref` is the intended declaration identifier.
- `source_data_rights_declarations` stores tenant, site, source, optional asset, supporting evidence ID and digest, permitted-purpose JSON, effective dates and declaration digest.
- `source_data_rights_events` stores append-only `declared/approved/rejected/revoked` lifecycle; current state is the latest row by rowid for the declaration.
- `source_evidence_documents` binds immutable document ID, tenant, site, source, digest and optional effective dates.
- `source_evidence_events` stores append-only evidence lifecycle; current state is the latest row by rowid for the evidence ID.

## Proposed additive D1 enforcement

Create migration 0064 with two independent BEFORE INSERT guards:

1. **Capability approval guard** on `source_capability_events`, only for `event_type='approved'`. Require exactly one declaration whose ID equals `source_capabilities.data_rights_ref`; exact tenant/site/source; exact asset equality using NULL-safe comparison; latest rights event approved; declaration effective now; exact supporting evidence ID/digest/scope; latest evidence event verified; evidence effective now; and both `measurement_ingestion` and `storage` in the permitted-purpose array. Keep analytics/model-training separate. Require `source_capabilities.evidence_ref` to equal the supporting evidence document ID so it cannot act as an unrelated free-form reference.

2. **Observation insert guard** on `observations`. Re-resolve the selected approved capability and its current rights/evidence chain at insertion time using the same exact scope, latest-event and effective-window checks. This second guard is essential: it blocks future observations after rights revocation or evidence withdrawal without mutating historical observations.

Use one shared SQL predicate text in migration generation/review to minimize semantic drift, but keep each trigger independently authoritative. All failure paths should raise stable, generic constraint messages and disclose no tenant-specific detail.

## Mandatory fixture migration before enabling the guards

Current local D1 tests deliberately create capabilities with unresolved references such as `fixture:rights`, `fixture:capability`, `fixture:data-rights`, and `fixture:capability-rights`. Those are valid only under the current permissive baseline and will correctly fail once the new guards are active.

Before applying 0064 in CI, introduce a deterministic synthetic fixture helper that creates, in order:
1. a verified evidence document with exact synthetic PDF bytes/digest and effective window;
2. its `registered` and independent `verified` events with matching audit events;
3. a rights declaration with exact evidence ID/digest, explicit `measurement_ingestion` and `storage` purposes, and current effective window;
4. its `declared` and independent `approved` events with matching audit events;
5. a capability whose `data_rights_ref` is the declaration ID and whose `evidence_ref` is the evidence document ID.

Convert fixtures in at least:
- `d1-observation-capability-tests.mjs`
- `d1-observation-capability-overlap-tests.mjs`
- `d1-capability-lifecycle-tests.mjs`
- `d1-source-capability-idempotency-tests.mjs`
- `d1-source-capability-event-idempotency-tests.mjs`
- `d1-http-integration.mjs`

The HTTP integration must create evidence and rights via authenticated routes, not by bypassing the application persistence path. Existing dedicated evidence/rights tests remain the positive/negative lifecycle source of truth.

## Required adversarial D1 cases

- missing/unresolved rights ID; duplicate/ambiguous or malformed reference
- tenant, site, source or asset mismatch (including NULL-vs-specific asset)
- wrong evidence ID or digest; evidence not latest verified
- rights not latest approved; rights rejected/revoked
- missing ingestion purpose; missing storage purpose; analytics/model-training not implicitly granted
- declaration and document future/expired effective windows
- exact positive path
- capability approved, then rights revoked: new observation denied
- capability approved, then evidence revoked: new observation denied
- historical observation remains readable and unchanged
- same idempotency replay remains deterministic and does not create another event

## Safe rollout sequence

1. Convert local fixtures to complete evidence/rights chains without changing current runtime behavior.
2. Run exact-head CI and verify all legacy fixtures have been eliminated from capability-positive paths.
3. Add migration 0064 guards and adversarial D1 tests.
4. Run exact-head CI on disposable local D1.
5. Independent source/security review and explicitly authorized read-only inventory on a controlled staging DB.
6. Resolve real legacy records through an approved product/legal policy before any staging migration.
7. Only then consider a separately authorized staging migration. No production or live D1 action is implied.

## Explicit non-actions

No production tenant data was queried or changed. No remote D1 migration, Worker deployment, merge, secret change, customer notification or paid resource was performed or authorized.
