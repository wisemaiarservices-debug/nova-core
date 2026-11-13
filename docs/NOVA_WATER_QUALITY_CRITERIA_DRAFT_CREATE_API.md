# NOVA water-quality criteria draft creation API

## Route

`POST /api/v1/tenants/{tenant_id}/water-quality-criteria`

The route is exposed only through the existing Cloudflare Access JWT gateway and private tenant API Service Binding. The request must be JSON and is limited to 64 KiB. The only accepted top-level request property is `entry`.

## Authorization and authorship

The gateway validates the Access JWT and creates a signed internal identity envelope. The private Worker verifies that envelope and consumes its request ID once. The Worker then requires exactly one active membership for the verified subject, an active tenant, and the `tenant_owner` or `tenant_admin` role.

The author is always taken from the verified subject. Tenant ID is taken from the route and must exactly match `entry.scope.tenant_id`. The request cannot assign a reviewer, change the author, or submit approval evidence.

## Draft contract

The entry must satisfy the existing structural registry contract, including explicit jurisdiction, version, publication/effective dates, authority evidence reference and digest shape, tenant/site scope, crop/method/intended-use scope, clause-level criterion provenance, and `review.status = draft`.

Unknown top-level, authority, scope, review or criterion fields are rejected. Review approvals must be absent or an empty array. Caller-supplied reviewer identity and approval records are not accepted. Site references and supersession references are checked structurally and enforced by D1 foreign keys.

## Atomic persistence

The immutable criteria entry and its initial append-only `draft_created` lifecycle event are inserted in one D1 batch. A uniqueness, foreign-key, tenant-suspension or lifecycle-trigger failure rejects the batch. The event actor and request ID are assigned by the server.

## Limitations

- This is draft creation only. Submission, reviewer provisioning, approval/rejection, supersession and retirement are not exposed.
- Evidence references and the SHA-256 digest are declared by the tenant. The API does not retrieve source documents, calculate the document digest, verify issuer authenticity, confirm current law or authenticate external reviewer credentials.
- Structural validation does not establish legal compliance, scientific suitability, water safety or operational authorization.
- No production route, remote D1 migration, deployment, paid service or customer data is part of this PR.

## Verification

Unit tests cover authorized and unauthorized roles, malformed payload envelopes, tenant-scope mismatch, provenance validation, and rejection of caller-supplied reviewer fields. The CI integration applies ordered migrations to disposable local D1 and exercises draft creation through the real local Access-gateway/private-Worker Service Binding, then reads the persisted draft back from the registry. Test fixtures are synthetic only.
