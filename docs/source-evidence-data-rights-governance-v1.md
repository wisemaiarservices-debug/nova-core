# Source evidence and data-rights governance — v1

Status: implementation contract / design proposal. No evidence or rights verification endpoint is claimed by this document.

## Current verified boundary

- Source capability drafts carry `evidence_ref` and `data_rights_ref` as non-empty strings.
- The current capability review route accepts a reviewer-supplied `evidence_ref`, but the database review guard does not resolve that reference to a persisted document or rights decision.
- The existing laboratory-report upload stores bounded PDF bytes, SHA-256, issuer/report metadata and an immutable `registered_unverified` record. It has no independent verification lifecycle and is not a data license registry.
- Existing laboratory-report reads verify the persisted digest and are tenant/site scoped. Registration alone must not be described as verification.
- Therefore the present capability approval path does not establish document authenticity, scope, legal authority, permitted purpose, or current rights. This is a governance gap, not proof that any existing evidence is false or unauthorized.

## Goals and non-goals

Goals:
1. Resolve evidence references to immutable, tenant/site/source-scoped records.
2. Verify document integrity and declared issuer/reference metadata.
3. Record independent human evidence review as append-only decisions.
4. Record data controller/provider, legal basis or license, permitted purposes, scope, restrictions and effective dates as a separate declaration.
5. Require independent human rights review, backed by resolvable documentary evidence.
6. Require both current evidence verification and current rights approval before a capability can be approved or used for new observations.
7. Preserve immutable source documents, declarations, decisions and audit history.

Non-goals:
- No automated legal interpretation or assertion that a document is legally sufficient.
- No AI approval, automatic source verification, data acquisition or device actuation.
- No public document URLs, external fetches, arbitrary URL dereferencing or cross-tenant evidence sharing.
- No change to tenant-scoped source policy.
- No retroactive claim that historical observations or existing approvals were independently reviewed.

## Reference model

Use opaque, tenant/site scoped identifiers, not caller-controlled URLs:

- `source-evidence:<id>` — a persisted document record with immutable bytes, SHA-256, media type, size, document type, issuer, document/reference number, issue date and optional validity interval. Initial state is registered/unverified.
- `source-rights:<id>` — an immutable data-rights declaration tied to the exact tenant, site, source and supporting evidence-document ID. It records provider/controller, rights basis, license/contract identifier, permitted purposes, geographic/asset scope, restrictions, effective dates and declarant.
- Capability `evidence_ref` must resolve to one evidence record for the same tenant/site/source.
- Capability `data_rights_ref` must resolve to one rights declaration for the same tenant/site/source and its supporting evidence document.
- Do not accept arbitrary external URLs as evidence. A URI string is not proof and must never be fetched by the Worker.

The existing laboratory-report store may be referenced through an explicit, verified adapter only after its issuer/sample/site/source relationship is checked. Do not silently reinterpret a laboratory report as a license or contract. The first generic document implementation should store a bounded PDF and verify its digest on read; it must not claim cryptographic issuer authenticity unless a trusted signature/issuer verification mechanism is separately implemented.

## Lifecycle and authority

Evidence document:
- registered_unverified
- verified (independent reviewer decision)
- rejected (independent reviewer decision)
- revoked (independent reviewer decision after prior verification)

Rights declaration:
- declared_pending
- approved (independent reviewer decision)
- rejected
- revoked
- expired (derived from effective_to; no mutable timer job required)

Every decision is an append-only event with actor, request ID, evidence reference, reason, timestamp and digest of the reviewed declaration/document metadata. Current status is derived from the event history and effective dates; do not let application code directly update status.

Review requirements:
- Reviewer must have active tenant membership and active site reviewer assignment at commit time.
- Reviewer cannot be the document uploader, rights declarant, source creator or capability creator.
- A reviewer must explicitly attest to the document's scope, issuer/reference consistency and integrity; this is a human workflow, not a machine assertion.
- Rights approval must explicitly record permitted purposes and the applicable scope; missing, ambiguous or expired terms fail closed.
- The reviewer decision must reference the exact immutable document/declaration version and its SHA-256 digest.
- Rejected/revoked records are not editable; submit a new version/document/declaration and retain the old history.

## Capability approval and ingestion gates

A capability approval event must be rejected by D1 unless all are true at commit time:
1. Capability is pending and has a submitted event.
2. Capability evidence reference resolves to exactly one verified document for the same tenant/site/source.
3. Capability data-rights reference resolves to exactly one approved declaration for the same tenant/site/source.
4. Rights declaration's supporting document is verified and digest-matched.
5. Rights declaration is effective at approval time and not expired/revoked.
6. Permitted purposes explicitly include the intended acquisition/processing/analytics purpose associated with the capability.
7. The independent reviewer is active, assigned and not any of the declarant/uploader/capability creator identities.
8. All records remain immutable and their scope joins are exact.

The observation commit guard must re-check current evidence and rights state when a new observation is inserted. Revocation, expiry, source unverification, site deactivation, asset deactivation, calibration invalidity or capability revocation must fail closed. This is necessary because rights can change after capability approval.

Legacy approved capabilities whose references cannot be resolved must not be silently treated as verified. Before enabling the new observation gate in any environment, produce a read-only inventory of affected capabilities and an explicit migration/review plan. Do not automatically backfill verification or rights approval.

## Proposed private API

All routes are behind the authenticated private Tenant API gateway; tenant identity comes from the verified gateway principal and active membership, never from request body fields.

- `POST /internal/v1/tenants/{tenant}/sites/{site}/sources/{source}/evidence-documents` — register bounded PDF document, idempotent by request key and content digest.
- `GET /internal/v1/tenants/{tenant}/sites/{site}/sources/{source}/evidence-documents/{document}` — metadata and digest only by default; raw bytes require a separate, audited access decision.
- `POST .../evidence-documents/{document}/review` — verify/reject; independent assigned reviewer only.
- `POST /internal/v1/tenants/{tenant}/sites/{site}/sources/{source}/data-rights` — create immutable pending rights declaration tied to an evidence document.
- `GET .../data-rights/{declaration}` — read scoped declaration and decision history.
- `POST .../data-rights/{declaration}/review` — approve/reject; independent assigned reviewer only.
- `POST .../data-rights/{declaration}/revoke` — revoke current approval with reason and evidence.
- Capability create must reference the canonical IDs above; capability review request must not override the stored references with an arbitrary string.

Responses must not disclose whether another tenant's document or declaration exists. All write routes require scoped idempotency and atomic audit/event persistence.

## Database delivery sequence

1. Add immutable document, rights declaration, event and idempotency tables with composite tenant/site/source foreign keys.
2. Add D1 guards for active tenant/site/source, active creator, exact reviewer assignment, independent review, immutable rows, event transitions and request-ledger/audit consistency.
3. Add local D1 tests for cross-tenant/source/site references, creator self-review, inactive/revoked reviewer, missing evidence, mismatched digest, expired rights, unsupported purpose, replay/conflict/concurrency and atomic rollback.
4. Add persistence functions and pure validators; no route until D1 tests pass.
5. Add private gateway route allowlists and Tenant API routes, deriving identity only from verified envelope.
6. Add capability approval guard and observation commit-time recheck only after a read-only inventory identifies existing approved capabilities that would be affected.
7. Run all ordered migrations from a clean disposable D1, all unit/Worker tests and exact-head CI. Keep PR draft.
8. Obtain independent security and governance review before any staging proposal.

## Immediate implementation boundary

The first code slice should be the schema + D1 guards + disposable D1 tests. Do not wire API routes, modify the observation trigger, backfill records, change remote D1, Cloudflare settings, deployments, secrets, production data or paid resources in the same step. Do not merge or deploy without explicit authorization and release-gate evidence.

## Implementation status — migration 0060

Implemented in `apps/api/migrations/0060_source_evidence_and_data_rights_governance.sql`:

- Immutable tenant/site/source-scoped PDF evidence documents, including bounded original bytes, SHA-256 field, issuer/reference metadata and effective dates.
- Append-only evidence events: registered, verified, rejected and revoked. Review decisions must match the stored digest and require an active assigned reviewer distinct from the uploader and source registrant.
- Immutable source data-rights declarations tied by composite scope and exact supporting-evidence digest.
- Append-only rights events: declared, approved, rejected and revoked. Approval requires the exact declaration/evidence digests, independent active reviewer authority and a currently effective declaration.
- Controlled permitted-purpose vocabulary: measurement ingestion, storage, quality assessment, analytics, model training, sharing and publication. Model-training permission must be explicitly listed; it is never implied by analytics.
- Append-only and audit-linked insert guards; cross-scope references fail closed.

Local D1 regression coverage is in `apps/tenant-api/scripts/d1-source-evidence-rights-tests.mjs`, added to `.github/workflows/ci.yml`. Exact-head CI run `44955053933` for commit `6d3e18760cea7d85bf35ed8e151f837b8fef967c` passed all three jobs: API tests, research/raster tests and Tenant Worker tests. The Tenant Worker job applied the full ordered migration chain through 0060 and passed the new evidence/rights tests plus all existing capability, gateway, observation and quality-flag D1 suites.

### Explicit limits of this slice

- No evidence upload/read/review or rights declaration/review API routes have been added.
- No capability approval trigger or observation commit trigger consumes these new registries yet. Existing capability and observation paths are unchanged; the new tables are not yet a production enforcement gate.
- SHA-256 is stored and reviewer decisions are bound to the declared digest. The future upload/read application layer must calculate and verify SHA-256 against the actual PDF bytes; SQLite does not calculate the document digest.
- No idempotency ledger has yet been added for evidence or rights create/review commands; request IDs are unique, but they are not a substitute for retry-safe idempotency keys.
- No automatic legal interpretation, issuer authenticity verification, AI approval, public URL dereferencing, or customer-data backfill is implemented.

Next safe step: add scoped idempotency ledgers and pure persistence/validation functions, then private Tenant API routes. Only after those are tested should a separate migration re-check evidence and rights state at capability approval and observation commit. A read-only inventory of existing approved capabilities is required before any enforcement cutover.
