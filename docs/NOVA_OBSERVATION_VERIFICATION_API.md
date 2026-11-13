# NOVA Core observation verification API

All routes are exposed through the human Cloudflare Access gateway and private Tenant API Worker. The gateway verifies the Access JWT and signs a minimal identity envelope; the Tenant API derives the reviewer identity from that verified envelope. Caller-supplied reviewer identities are never accepted.

## Assign a site reviewer

`POST /api/v1/tenants/{tenant_id}/observations/reviewers/assign`

Tenant owners/admins may assign a reviewer for one exact site:

```json
{
  "site_id": "site-123",
  "reviewer_subject": "reviewer@example.test",
  "evidence_ref": "appointment:record-123"
}
```

Assignments use the fixed `measurement_reviewer` role. The assigning subject cannot assign themselves. Revocation uses `POST /api/v1/tenants/{tenant_id}/observations/reviewers/revoke` with the same fields plus a required `reason`. Revoked assignments are terminal; create a new subject/assignment record rather than reactivating one.

## Verify, reject or revoke one observation

`POST /api/v1/tenants/{tenant_id}/observations/{observation_id}/verification`

Verify:

```json
{ "decision": "verify", "evidence_ref": "inspection:record-456" }
```

Reject or revoke require a reason:

```json
{ "decision": "reject", "evidence_ref": "inspection:record-456", "reason": "Measurement record is incomplete" }
```

```json
{ "decision": "revoke", "evidence_ref": "recheck:record-789", "reason": "Original verification evidence withdrawn" }
```

The reviewer must have an active tenant membership, exact site read grant and active site-scoped measurement-reviewer assignment. The observation must belong to the route tenant and assigned site. The API checks the persisted ingestion audit event and denies review when the reviewer subject matches the ingestion service actor or when submitter independence cannot be established.

Allowed state transitions:

- `unverified -> verified`: independent reviewer records a verification event.
- `unverified -> rejected`: independent reviewer records a rejection and reason.
- `verified -> unverified`: reviewer revokes a prior verification with evidence and reason.
- A rejected observation cannot be promoted by this workflow. A revoked observation may be reviewed again.

The append-only decision event and observation status update execute in one D1 batch. Database triggers require a matching event before a verification status can change; direct status edits without a corresponding decision event are rejected. Reviewer assignments and assignment history are also retained, with immutable scope and append-only events.

## Trust and limitations

This workflow records that an assigned human reviewer checked referenced material. It does **not** establish scientific accuracy, sensor calibration, laboratory accreditation, measurement traceability, sample representativeness, regulatory compliance or legal suitability. Evidence references are identifiers, not authenticated external documents. Reviewers must use an independently governed inspection/evidence process outside this endpoint.

No observation is automatically verified on ingestion. Missing ingestion audit provenance, missing reviewer assignment, duplicate/ambiguous records, cross-tenant/site access, stale state transitions and self-review attempts fail closed. Verification revocation immediately returns the observation to `unverified`, so downstream measured-sample comparison no longer accepts it.

The API does not trigger irrigation, treatment, energy, infrastructure or other operational decisions. All operational recommendations remain advisory and require separate human approval.
