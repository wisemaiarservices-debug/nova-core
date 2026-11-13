# NOVA criteria reviewer evidence context

A tenant-scoped version read is available at:

`GET /api/v1/tenants/{tenant_id}/water-quality-criteria/{entry_id}/{version}`

The response includes the immutable criteria entry, ordered lifecycle events, approval decisions and their evidence references, current lifecycle status, and explicit non-claims:

- `legal_status: not_verified`
- `scientific_suitability: not_assessed`
- `operational_decision: not_authorized`

An active tenant member with a read role can read entries in that tenant. An external reviewer without tenant membership can read only an entry whose jurisdiction matches an active reviewer assignment for that exact tenant and verified Access subject. A reviewer assignment for another jurisdiction, a revoked assignment, an inactive tenant, or an unknown entry does not grant access. The reviewer can therefore inspect the declared criteria and prior decisions before submitting their own review, without receiving general tenant read access.

The response exposes only approvals and lifecycle events for the selected entry/version. It does not expose other tenant entries or the complete reviewer directory. The tenant admin reviewer-directory endpoint remains separately restricted to owners/admins.

List reads include the latest lifecycle event type for each entry, while the detail read returns the bounded event and approval history. Evidence references remain caller-declared and are not fetched or authenticated. A visible approval is a record of human decisions, not proof of legal validity, scientific correctness, water safety or operational authorization.
