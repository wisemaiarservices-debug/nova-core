# Site configuration reviewer provisioning

## Routes

- `POST /api/v1/tenants/{tenant_id}/sites/{site_id}/configurations/reviewers/assign`
- `POST /api/v1/tenants/{tenant_id}/sites/{site_id}/configurations/reviewers/revoke`
- `GET /api/v1/tenants/{tenant_id}/sites/{site_id}/configurations/reviewers`

The routes are exposed through the human Cloudflare Access gateway and private tenant API Service Binding. The private Worker has no public route.

## Authorization

Assignment and revocation require:
- a verified gateway subject;
- exactly one active membership in the active tenant;
- the `tenant_owner` role;
- exactly one exact site-level `manage_members` grant.

Roster reads require an active read-capable tenant membership and exactly one exact site-level `read` grant. Missing or ambiguous authorization returns `404`.

Reviewers are assigned to one site and one explicit role: `engineering_reviewer` or `operations_reviewer`. An owner cannot assign themselves. Caller-supplied role, status, actor, and audit metadata are rejected.

## Evidence and lifecycle

Assignment and revocation each persist the assignment-state change, append-only reviewer event, and tenant audit event in one D1 batch. Assignment evidence references and original assigner are immutable. Revocation is terminal; a revoked row cannot be reactivated. A new identity/assignment requires a new reviewer subject rather than rewriting history.

The roster returns assignments and their immutable event history. Evidence references are recorded as supplied; this API does not independently authenticate certificates, professional registrations, employment, competence, or evidence documents.

## Deliberate limitations

This increment provisions reviewers only. It does not yet record configuration decisions, approve/reject a configuration, supersede versions, authorize commissioning, or activate device settings. Approval and operational authority remain unavailable until a separate review-decision contract and validation process exist.
