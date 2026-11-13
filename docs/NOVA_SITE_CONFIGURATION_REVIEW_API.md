# Tenant site configuration review API

## Route

`POST /api/v1/tenants/{tenant_id}/sites/{site_id}/configurations/{version}/review`

The route is exposed through the human Cloudflare Access gateway and private tenant API Service Binding. It accepts exactly `decision` and `reason`, where decision is `approve` or `reject` and reason is a bounded non-empty explanation.

## Authorization and separation of duties

The tenant API derives the reviewer subject from the verified gateway identity. A review requires:
- exactly one active membership in the active route tenant;
- role `tenant_owner` or `tenant_admin`;
- exactly one exact tenant/subject/site `update` grant;
- an existing configuration version in the route tenant and site;
- a reviewer subject different from the configuration creator;
- the latest lifecycle event to be `submitted_for_review`.

The service appends either `approved_for_review` or `rejected` and a corresponding tenant audit event in one D1 batch. The database lifecycle trigger independently enforces the valid transition. A duplicate or concurrent review cannot transition a terminal record again.

This initial release uses tenant-admin/owner plus site-update authority; it does not yet provide separate professional reviewer credentialing or an external engineering sign-off system. The reviewer identity is authenticated by Access but their professional qualifications and independence outside the creator-subject check are not independently verified.

## Meaning

- `approved_for_review` means a different authorized tenant administrator recorded an approval event with a reason. It is not engineering certification, legal approval, calibration verification, commissioning or permission to operate.
- `rejected` records a human rejection reason. A corrected configuration must be submitted as a new immutable version.
- Review does not push configuration to gateways/devices, change active operating settings, alter global model parameters or trigger irrigation/energy actions.

## Validation

Unit tests cover admin/grant checks, creator self-review denial, submitted-only transitions, approval/rejection audit writes and atomic failure. Local CI uses disposable D1 and the actual Access gateway/private Worker Service Binding to approve v6 with a different tenant admin, reject v7, and verify the resulting lifecycle events through the read API.
