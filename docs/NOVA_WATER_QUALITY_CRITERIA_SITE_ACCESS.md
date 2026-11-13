# Water-quality criteria site access

Criteria records may be tenant-wide or site-scoped.

- A record with no site association is tenant-wide and can be read by an active tenant member whose role includes the read capability.
- A site-scoped record is visible to an ordinary tenant reader only when the authenticated Access subject has an exact active tenant resource grant for that site with the `read` action.
- A jurisdiction-assigned criteria reviewer may read records in the reviewer's assigned jurisdiction, even without a site grant, because review duties are jurisdiction-scoped. This exception does not grant access to unrelated tenant resources.
- List queries apply the same site-grant/reviewer-jurisdiction filter in SQL before returning records; detail reads independently enforce the grant before returning the record.
- Approved-criteria resolution and sample assessment require the caller's site-read grant and verify the entry/context scope independently.

The API uses the verified gateway subject, never a caller-supplied subject. Tenant ID is bound to the route and all grant queries are scoped to tenant, subject, resource type, resource ID and action. Denied site access is returned as not found to avoid confirming another site's criteria identifiers.

These controls enforce application-level tenant/site access. They do not replace a broader security review of identity lifecycle, Cloudflare Access policy, account administration, database backups, or operational monitoring.
