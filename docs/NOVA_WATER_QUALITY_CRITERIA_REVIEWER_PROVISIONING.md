# NOVA water-quality criteria reviewer provisioning

## Access-controlled routes

- `POST /api/v1/tenants/{tenant_id}/water-quality-criteria/reviewers/assign`
- `POST /api/v1/tenants/{tenant_id}/water-quality-criteria/reviewers/revoke`
- `GET /api/v1/tenants/{tenant_id}/water-quality-criteria/reviewers`

All routes pass through the Cloudflare Access JWT gateway and private tenant API Service Binding. The API derives the actor from the signed, verified gateway subject. Only an active tenant owner or tenant admin with one active membership can provision or inspect assignments. Tenant ID is taken from the route, not from the request body.

## Assignment contract

Assignment accepts only `reviewer_subject`, `reviewer_role`, `jurisdiction`, and `evidence_ref`. Roles are limited to `regulatory_reviewer` and `domain_expert`. The reviewer subject must be a non-empty Access subject and cannot equal the assigning administrator. The assignment is tenant- and jurisdiction-scoped. Existing assignments cannot be silently overwritten; duplicate assignment returns a conflict. A revoked assignment is retained and cannot be reactivated or rewritten.

The supplied evidence reference records the administrator's basis for appointing that subject. It is not independently authenticated, and it does not prove professional qualifications, regulatory authority, accreditation, legal delegation, or identity outside the configured Access identity provider. The reviewer must later authenticate with an Access subject that exactly matches the assigned subject.

## Revocation contract

Revocation requires the exact reviewer subject, role, jurisdiction, an evidence reference and a reason. Only an active assignment in that exact scope can be revoked. Reviewer scope and identity remain immutable. Revocation is retained and prevents future approvals under that assignment.

## Auditability and atomicity

Migration `0008` adds an append-only reviewer event table. Assignment and its `assigned` event, or revocation and its `revoked` event, are written in one D1 batch. SQL constraints bind events to the stored reviewer identity, role, jurisdiction, current state and active tenant. Update and delete of reviewer history are blocked. The read route returns current assignments and bounded event history to tenant owners/admins only.

## Boundaries

- Tenant admins can appoint an opaque Access subject; the API does not verify a person's credentials, professional standing, legal authority, employer or independence.
- Self-assignment is blocked, but an administrator may still appoint another subject they control. Governance policy and independent due diligence remain necessary.
- Reviewer assignment evidence is a caller-declared reference, not a fetched or verified document.
- This PR does not submit criteria, collect approvals, approve/reject entries, or authorize water-quality decisions.
- No legal compliance, water safety, scientific suitability, regulatory endorsement or operational approval is inferred.
- CI fixtures are synthetic. No customer data, remote D1 migration, production deployment or paid service is used.

## Validation

Unit tests cover role restrictions, self-assignment denial, exact role/jurisdiction/evidence fields, revocation reason, and append-only history. The local multi-Worker CI integration exercises assignment, list and revocation through Cloudflare Access JWT verification, the gateway, the private Worker Service Binding and disposable local D1.
