# Tenant site configuration history read API

## Routes

- `GET /api/v1/tenants/{tenant_id}/sites/{site_id}/configurations`
- `GET /api/v1/tenants/{tenant_id}/sites/{site_id}/configurations/{version}`

Both routes are exposed through the human Cloudflare Access gateway and private tenant API Service Binding. The private Worker has no public route.

## Authorization

The tenant API derives the subject from the verified gateway identity envelope. It requires:
- exactly one active membership for the subject in the active route tenant;
- a tenant role with read capability;
- exactly one exact tenant/subject/site `read` resource grant.

The query is scoped by tenant and site, and version reads use an exact version selector. A missing grant, inactive tenant, duplicate membership or unknown version returns `404 not_found` to avoid disclosing the existence of another site's configuration.

## Response

The list returns at most 100 immutable versions, newest first, including:
- configuration ID and version;
- schema ID and canonical JSON configuration;
- SHA-256 content digest;
- creator subject, request ID and creation timestamp;
- latest append-only lifecycle event status.

The version route returns one exact version. The read path does not mutate configuration history, change lifecycle state, or apply the configuration to equipment.

## Meaning and limitations

A stored version can be `submitted_for_review`, `approved_for_review`, `rejected`, `withdrawn`, `superseded`, or unknown. The read API reports the persisted event; it does not independently validate reviewer qualifications, commissioning, installation, calibration, scientific suitability, legal permits, or device connectivity.

Configuration JSON is a client/site description, not a command to devices. No operational changes are triggered by reading it.

## Validation

Unit tests cover exact tenant/site/version scoping and denied memberships/grants. Local CI reads the v1–v6 fixtures through the actual Access gateway/private Worker Service Binding and disposable D1, and confirms an ungranted site cannot list its configuration history.
