# NOVA Core controlled-staging gate — 2026-11-20

## Purpose and scope

This checklist defines the minimum evidence required before a controlled NOVA Core staging environment can be provisioned and used for a two-tenant integration test. It covers the private tenant gateway and API, Cloudflare Access, D1, ingestion identities, and the connected NOVA OS/product clients.

This is a readiness and evidence document only. It does not provision infrastructure, authorize deployment, authorize database migrations, enable product ingestion, or approve a pilot site.

## Current source-level facts

- The private tenant API Worker config sets `workers_dev = false` and `preview_urls = false`, declares no public route/custom domain, and explicitly leaves DB and `ACCESS_*` bindings absent pending approved setup.
- The tenant gateway Worker config also disables Workers.dev and preview URLs and declares a Service Binding to `nova-core-tenant-api`. Its Access-protected hostname and identity settings must be configured separately.
- The public NOVA Core API Worker is a separate service. Its public URL is not the private tenant gateway and must never be substituted for the authenticated tenant API.
- Core PR #296/#297 provide shared contract and authenticated ingestion-handler tests against disposable local D1 with synthetic identities. They do not prove live Cloudflare Access, a deployed private Service Binding, remote D1, or production tenant isolation.
- Product ingestion adapters remain opt-in/disabled pending verified endpoint, provider identity, exact service grants, and tenant/site/source/asset registration.

## Gate 0 — authority, environment, and free-tier constraints

Required evidence:
- Named staging owner and reviewer; explicit written approval for the specific staging environment and test window.
- Confirm the Cloudflare account remains on Workers Free and that the proposed design fits current request, CPU, storage, D1, and other applicable free-tier limits.
- Confirm Vercel Hobby and other connected free plans/quotas are sufficient for any UI previews; no paid upgrade, overage, or add-on is permitted.
- Record environment name, purpose, data classification, retention, deletion owner, and emergency stop/rollback owner.
- Use synthetic tenant/site/source/asset data only. No pilot/customer site, customer telemetry, personal data, or production secrets.

Pass condition: approvals and capacity evidence are recorded; otherwise STOP.

## Gate 1 — Cloudflare Access identity boundary

Required evidence:
- Dedicated staging Access application and exact hostname, with policy export/review showing only explicitly authorized test identities.
- Exact issuer and audience values verified against the deployed gateway configuration.
- RS256/JWKS verification, key rotation behavior, expiry/not-before handling, and fail-closed behavior tested against the actual Access tenant.
- Credentialed CORS allowlist contains only exact staging UI origins; preflight permits only documented headers/methods. CORS is not treated as authentication.
- Browser cookies and caller-supplied tenant, subject, actor, or service headers cannot establish identity or cross the gateway trust boundary.
- Access denial, expired token, wrong audience/issuer, unavailable JWKS, and untrusted origin tests captured.

Pass condition: independent reviewer confirms the deployed policy and negative tests. Source code or local synthetic JWT tests alone do not pass this gate.

## Gate 2 — private Worker topology and deployment provenance

Required evidence:
- Deploy the tenant API and gateway only from reviewed immutable commit SHAs using an explicitly approved staging workflow.
- Confirm both Workers have Workers.dev and preview URLs disabled.
- Confirm the tenant API has no public route/custom domain and is reachable only through the intended gateway Service Binding.
- Verify the Service Binding points to the exact staging tenant API service, not production or a public Worker.
- Verify no alternate route, preview hostname, direct API hostname, or public Core API endpoint can reach tenant-only routes.
- Record deployed script versions, bindings, compatibility settings, deployment timestamps, and rollback versions.

Pass condition: edge-level tests from inside and outside the Access boundary demonstrate only the approved path succeeds.

## Gate 3 — D1 schema, migration, and legacy ACL review

Required evidence:
- Create a dedicated disposable staging D1 database; do not point tests at production or an unknown existing database.
- Export migration inventory and applied migration history; verify checksums/order and apply only reviewed migrations to the staging database.
- Verify all tenant tables have tenant-scoped ownership constraints and indexes required by the API.
- Inspect actual live schema permissions/ACLs. Resolve legacy Supabase anon/authenticated permissive policies where applicable; repository migration files are not proof of live policy state.
- Test least-privilege database bindings and prove the gateway/Worker cannot access another environment's database.
- Capture pre/post migration inventory and rollback/rebuild procedure.

Pass condition: actual staging database state is inspected and signed off. No remote migration before this gate is explicitly approved.

## Gate 4 — tenant and service identity fixtures

Required evidence:
- Two synthetic tenants with distinct sites, modules, sources, assets, users, and service identities.
- Exact issuer/audience, service name, tenant ID, source ID, module scope, and grant records are documented for each synthetic service.
- Ownership checks reject cross-tenant site/source/asset references, inactive sites/assets, missing grants, and mismatched modules.
- Unknown or unverified source/asset states remain unverified; no inferred ownership or silent fallback.
- Revocation and deactivation take effect for new operations; retries remain scoped to the original operation and tenant.

Pass condition: positive and negative cases are executed against staging and persisted evidence shows no cross-tenant read/write.

## Gate 5 — product and NOVA OS integration

Verify each surface independently; a website or navigation link is not proof of product integration.

- NOVA OS: Operator Workspace and Engineering Console use the approved staging gateway, show authenticated/unauthenticated/error states accurately, and never expose secrets.
- NeoAgro: server-side producer adapter only; exact approved host, TLS port 443, provider identity and source grant; ingestion remains disabled until approved.
- NeoGrid: same requirements, with grid telemetry and source/asset mapping verified independently.
- NeoCell: same requirements, with device identity, calibration, telemetry provenance and source/asset mapping verified independently.
- Command Center: clearly distinguishes product navigation/scenario fixtures from verified live service status.
- FieldOps: mission approval and physical execution remain disabled unless a separately reviewed durable workflow is implemented and authorized.

For every integration, capture request/response IDs, tenant scope, source/asset IDs, verification state, idempotency behavior, and failure behavior using synthetic data.

## Gate 6 — end-to-end acceptance and rollback

Required staging scenarios:
1. Tenant A and Tenant B can each authenticate and read only their own fixtures.
2. Cross-tenant site, source, asset, and operation attempts are denied and leave no unauthorized rows.
3. Valid service identity with exact grant can submit an observation; invalid signature, wrong audience, revoked identity, or wrong grant is denied.
4. Exact retry is idempotent; changed payload under the same key conflicts without duplicate audit events.
5. Audit write failure rolls back acceptance; no success response is returned.
6. Access/JWKS outage, gateway/API outage, D1 failure, timeout, and malformed input fail closed with traceable request IDs.
7. UI loading, empty, error, denied, recovery, and disconnected states are tested on each product surface.
8. Rollback to the recorded staging Worker versions and disposal/rebuild of staging D1 are rehearsed.

Pass condition: all required cases pass on the exact deployed SHAs, with logs/evidence reviewed by someone other than the implementer.

## Release decision

- **Blocked now:** live Access application/policy, gateway hostname and identity settings, deployed private Worker Service Binding, staging D1 provisioning/migration state, and actual remote tenant-isolation evidence are not established by the available source/CI evidence.
- **Allowed now:** source review, local tests, synthetic fixtures, documentation, and draft PRs.
- **Not allowed without separate approval:** staging provisioning, remote D1 migration, Cloudflare Access or DNS changes, Worker deployment, product ingestion activation, production deployment, pilot/customer data, or any paid resource.

A green CI run is evidence for the tested commit and test environment only. It is not a staging or production release approval.
