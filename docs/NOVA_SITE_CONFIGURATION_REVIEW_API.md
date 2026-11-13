# Tenant site configuration review API

## Route

`POST /api/v1/tenants/{tenant_id}/sites/{site_id}/configurations/{version}/review`

The route is exposed through the human Cloudflare Access gateway and private tenant API Service Binding. It accepts exactly `decision` and `reason`, where decision is `approve` or `reject` and reason is a bounded non-empty explanation.

## Authorization and separation of duties

The tenant API derives the reviewer subject from the verified gateway identity. A review requires:
- exactly one active membership in the active route tenant;
- role `tenant_owner` or `tenant_admin`;
- exactly one exact tenant/subject/site `update` grant;
- exactly one active site reviewer assignment for the authenticated subject, with role `engineering_reviewer` or `operations_reviewer`;
- an existing configuration version in the route tenant and site;
- a reviewer subject different from the configuration creator;
- the latest lifecycle event to be `submitted_for_review`.

The service appends either `approved_for_review` or `rejected` and a corresponding tenant audit event in one D1 batch. The database lifecycle trigger independently enforces the valid transition. A duplicate or concurrent review cannot transition a terminal record again.

Reviewer assignments are provisioned by a tenant owner through the separate reviewer-governance endpoints and are scoped to one site and one role. A reviewer with no active assignment, multiple active role assignments, or a revoked assignment cannot decide a configuration. The role is recorded in the review response and audit details. Professional qualifications, evidence authenticity and independence outside the creator-subject check are not independently verified.

## Meaning

- `approved_for_review` means a different authorized tenant administrator recorded an approval event with a reason. It is not engineering certification, legal approval, calibration verification, commissioning or permission to operate.
- `rejected` records a human rejection reason. A corrected configuration must be submitted as a new immutable version.
- Review does not push configuration to gateways/devices, change active operating settings, alter global model parameters or trigger irrigation/energy actions.

## Validation

Unit tests cover admin/grant and reviewer-assignment checks, creator self-review denial, submitted-only transitions, approval/rejection audit writes and atomic failure. Local CI uses disposable D1 and the actual Access gateway/private Worker Service Binding to approve v6 with a different tenant admin, reject v7, and verify the resulting lifecycle events through the read API.
