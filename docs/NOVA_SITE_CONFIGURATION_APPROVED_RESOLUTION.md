# Latest approved site configuration resolution

## Route

`GET /api/v1/tenants/{tenant_id}/sites/{site_id}/configurations/effective`

The route requires an active tenant membership with read capability and an exact site-read grant. It returns the highest sequential configuration version whose latest lifecycle event is `approved_for_review`.

## Selection behavior

- A newer version that is still `submitted_for_review` does not replace the previously approved version.
- A newer version that is `rejected` does not replace the previously approved version.
- A version whose latest event is `withdrawn` or `superseded` is not eligible.
- If no version is currently approved, the response is `not_available` with reason `no_approved_configuration`.
- Selection is scoped to the exact tenant and site; no cross-tenant or cross-site fallback occurs.

## Important distinction

The endpoint resolves the latest approved configuration record for downstream read-only context. It does not activate, deploy, commission or push settings to equipment. The response always includes `operational_decision: not_authorized`.

An approved record is a tenant administrator's recorded review decision. It is not engineering certification, legal approval, calibration evidence, device connectivity, or proof that field conditions match the submitted configuration. Operators must not treat this endpoint as an execution command.

## Validation

Unit tests verify the latest approved version is selected even when a newer version is pending or rejected, and that no-approved state remains explicit. Local CI creates v6 and v7, approves v6, rejects v7, and verifies the effective route still returns v6 through the actual Access gateway/private Worker Service Binding and disposable D1.
