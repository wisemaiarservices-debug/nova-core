# Database-backed water-quality criteria resolution

## Route

`POST /api/v1/tenants/{tenant_id}/water-quality-criteria/{entry_id}/{version}/resolve`

The request body contains exactly `context` and `sampled_at`. Context must include the route tenant ID, site ID, jurisdiction, crop ID, irrigation method and intended use. The caller must have an active tenant membership with a read role. Access JWT identity is verified by the gateway; the tenant ID is bound from the path and must exactly match the context.

## Database-to-resolver bridge

The immutable criteria JSON stores the creation-time draft envelope. The resolver does not trust that stale embedded status. It loads the current append-only lifecycle event and immutable approval rows from D1, derives the authoritative lifecycle status, and hydrates the resolver's approval envelope from persisted server-recorded reviewer identities, roles, timestamps and evidence references.

Only a latest lifecycle event of `approved` maps to the resolver's approved state. Draft, submitted, rejected, superseded, retired and missing states remain `not_assessed`. The pure resolver then requires exact tenant/site/jurisdiction/crop/method/intended-use scope and a sample date inside the declared effective period.

## Result meaning

`approved_entry_scope_match` means the stored entry passed the declared human approval lifecycle and its declared scope/date matches the supplied context. It does not authenticate the source document, verify the issuing authority or current law, establish scientific suitability, establish that the sample is representative, or authorize an operational action.

The response preserves explicit non-claims: legal status not independently verified; source authenticity not independently verified; operational decision not authorized. A `not_assessed` response includes the reason and does not fall back to another tenant, jurisdiction, crop, method, intended use, unit or version.

## Validation

Unit tests cover persisted lifecycle hydration, dual-role approval evidence, draft/pending/rejected states, cross-tenant and scope mismatches, and effective-date rejection. Local CI creates a draft, assigns two reviewers, submits it, records their independent approvals, then verifies the database-backed resolver returns not assessed before approval and an exact approved-scope match afterward using disposable local D1 and the actual local Access gateway/private Worker Service Binding.
