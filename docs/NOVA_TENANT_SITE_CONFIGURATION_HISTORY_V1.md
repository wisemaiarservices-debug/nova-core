# Tenant-scoped client configuration history v1

Migration 0005 introduces append-only storage primitives for client/site configuration versions.

## Records
- `tenant_site_configurations`: immutable JSON snapshot, schema identifier, caller subject, request ID, SHA-256 content digest, tenant/site ownership and version.
- `tenant_site_configuration_events`: append-only submission/review/rejection/withdrawal/supersession history.

## Guarantees
- Every snapshot is bound by composite foreign keys to the exact tenant and site.
- Configuration version is unique and sequential per tenant/site (`v1`, `v2`, ...); gaps and re-use are rejected.
- Updates and deletes are rejected. A changed profile is a new version.
- Snapshots must be JSON objects with a lowercase SHA-256 digest.
- Review events are append-only and tenant-scoped, with database-enforced transitions: submit once, then approve/reject/withdraw; only approved-for-review versions may be superseded.
- Suspended tenants cannot create snapshots or review events.
- No tenant/site/customer rows are created or backfilled by this migration.

## Deliberate non-guarantees
- The database checks SHA-256 digest shape, but does not recompute the digest. The future write service must canonicalize JSON and recompute/compare SHA-256 before insert; a digest does not validate scientific truth or caller provenance.
- This migration does not authenticate a subject, authorize a role, or enforce who may approve. Those checks belong in the private API after the verified Access identity and exact tenant/site grant have been checked.
- An `approved_for_review` event is not operational activation. No activation event, live device provisioning, control permission, or production route is added.
- The current private tenant Worker remains read-only. These tables are not reachable through HTTP until a separate authorization-first write API is reviewed and tested.
- Apply only after migrations 0002–0004 and explicit D1/retention/rollback review.
