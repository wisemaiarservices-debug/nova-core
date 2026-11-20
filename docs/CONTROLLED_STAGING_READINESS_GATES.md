# NOVA Core controlled-staging readiness gates

**Status: NOT READY — documentation and local CI evidence only.**

This document defines the evidence required before a controlled staging environment can be provisioned or used. It does not authorize Cloudflare changes, D1 creation or migration, Access policy changes, secret provisioning, product ingestion enablement, tenant onboarding, or deployment.

## 1. Current verified boundary

The repository has local integration evidence for the authenticated ingestion Worker and for the tenant gateway-to-private-API Service Binding path. These tests use disposable local D1/workerd resources and synthetic identities/data. They do not prove Cloudflare edge Access enforcement, remote D1 behavior, deployed Service Binding isolation, live secret parity, a configured hostname, or production tenant readiness.

The private tenant API Wrangler configuration currently declares `workers_dev = false` and `preview_urls = false`, with no public route or custom domain. Its README explicitly says its D1 and Access bindings are not configured. The gateway configuration declares a Service Binding to `nova-core-tenant-api`, but its required Access settings, CORS origins, HMAC secret and protected hostname are not provisioned.

The repository's Cloudflare GitHub Actions deployment workflow deploys the separate Python public Core API Worker. It does **not** deploy the private tenant API or tenant gateway. A successful run of that workflow must never be represented as evidence that the private tenant boundary is deployed.

## 2. Blocking prerequisites

| Gate | Required evidence | Current disposition |
|---|---|---|
| Environment and cost boundary | Named isolated staging environment; Workers Free plan confirmed; D1 capacity, request/write quotas, retention and storage checked; no paid upgrade or overage | **Not evidenced** |
| D1 target and recovery | Approved staging D1 identity; schema inventory; backup/restore rehearsal; retention and recovery owner; disposable test database kept separate | **Not provisioned / not evidenced** |
| Migration chain | Review and checksum the complete ordered chain, including base schema and tenant isolation/replay-protection migrations; validate against disposable D1; document forward recovery and rollback limits | **Local CI only; remote migration not run** |
| Cloudflare Access | Exact staging hostname; Access application and restrictive policy; approved user/group allowlist; exact issuer and audience; token expiry/revocation behavior tested at the edge | **Not provisioned** |
| Private tenant API | Deploy with no public hostname, route, workers.dev hostname or preview URL; D1 and human Access bindings set only after approval; verify public-origin denial | **Source config only** |
| Tenant gateway | Exact Service Binding to the private API; exact CORS origins; Access JWT verification; no wildcard origin; no browser identity/cookie/header forwarding; protected hostname attached only after edge tests | **Source config only** |
| Internal service authentication | Independently generated high-entropy HMAC secret provisioned through platform secret storage to both Workers; parity verified without exposing values; rotation and revocation procedure documented | **Not provisioned** |
| Tenant/source authorization | Synthetic tenant memberships, roles, exact resource grants, site/source/asset ownership and inactive-state cases; no real customer/site data | **Local fixtures only** |
| Product producer identity | Explicitly registered service identities and exact source grants for each approved producer; host pin, TLS port 443 and public-host denylist verified; producer opt-in remains disabled until approval | **No live producer registrations or grants evidenced** |
| Observability and operations | Request IDs, audit evidence, redaction review, alerting, incident owner, quota monitoring and tested stop/disable procedure | **Not evidenced at Cloudflare edge** |
| Independent review | Independent security review of the deployed configuration and evidence, not merely source review or CI | **Not completed** |

## 3. Mandatory staging acceptance scenarios

Use only synthetic tenants, sites, assets, sources, observations and identities in an isolated staging environment. No pilot site is approved.

1. **Identity and Access:** valid approved user succeeds; missing, expired, wrong-issuer, wrong-audience, revoked and tampered tokens fail closed.
2. **Private-origin isolation:** direct Internet requests to the private API fail; only the intended gateway Service Binding can reach it. Confirm no workers.dev, preview URL, route or custom-domain exposure exists.
3. **Tenant isolation:** Tenant A cannot enumerate, read or infer Tenant B memberships, sites, assets, sources, observations or audit events. Repeat across every resource type and inactive-state transition.
4. **Authorization:** insufficient role, missing exact resource/action grant, wrong service identity, wrong source, wrong site, wrong module and wrong asset all fail closed.
5. **Request integrity:** caller-supplied tenant/service/subject headers and cookies cannot override verified identity; internal HMAC tampering, stale timestamps and replayed request IDs are rejected.
6. **Ingestion durability:** authenticated accepted write; exact retry is idempotent; changed payload under the same idempotency key conflicts; audit and observation commit atomically; simulated persistence/audit failure leaves no partial acceptance.
7. **CORS and browser behavior:** exact approved origins work; unknown origins, wildcard credentials, disallowed methods/headers and unapproved preflight requests are rejected.
8. **Failure and recovery:** Access/JWKS outage, D1 outage, Worker errors, quota exhaustion and timeout produce safe errors; retry behavior does not duplicate writes; operators can disable the path and recover.
9. **Product boundary:** NeoAgro, NeoGrid and NeoCell remain demo-labelled until their own approved producer identities, mappings and telemetry paths are proven. Command Center and FieldOps remain scenario/preview surfaces until their independent integrations and action workflows are verified. NOVA OS consoles must not infer readiness from public Core API health.
10. **Evidence and audit:** preserve exact commit SHAs, deployment IDs, migration checksums, test timestamps, sanitized request IDs, results and reviewer sign-offs. Never store tokens, HMAC keys, private keys or customer data in the evidence ledger.

## 4. Required deployment sequence — only after approval

1. Confirm the staging account/plan, resource quotas, environment owner and written approval. Stop if the Free plan cannot safely support the test; do not upgrade or incur charges.
2. Create or identify an isolated staging D1 database and rehearse the complete migration chain on a disposable local database. Verify backup and recovery before any remote migration.
3. Configure the staging Cloudflare Access application/policy and exact issuer/audience for the chosen hostname. Review policy with an independent operator.
4. Provision the approved D1 binding and required Access settings for the private tenant API. Deploy it with public exposure disabled.
5. Verify private-origin isolation from outside Cloudflare and through the intended Service Binding.
6. Provision the shared HMAC secret using the platform secret store; verify both Workers use the same secret without printing or recording it.
7. Configure the gateway's exact CORS origins and Access settings, deploy the gateway and attach only the Access-protected staging hostname.
8. Run every acceptance scenario above with synthetic data. Capture evidence against exact deployed SHAs and environment IDs.
9. Obtain independent security review and explicit human acceptance before enabling any product producer or scheduling a presentation/live test.
10. Keep production separate. Staging success is not production authorization.

## 5. Stop, rollback and no-go conditions

Immediately stop the test and disable the staging entry point if there is any cross-tenant access, public exposure of the private API, identity/header spoofing, HMAC failure accepted as valid, duplicate durable writes, missing audit evidence, unexpected data mutation, secret exposure, or unbounded cost/usage.

Before execution, the environment owner must document the supported Worker rollback mechanism, D1 backup/restore procedure, migration compatibility constraints, secret rotation/revocation, and the exact steps to detach the staging hostname and disable the gateway. Do not assume a schema migration is safely reversible; use a reviewed forward-fix or restore plan appropriate to the actual migration.

No staging or production action is permitted while any blocking prerequisite is unknown. A local CI pass, READY preview, HTTP 200, public API health response, OpenAPI document, or successful website navigation does not satisfy these gates.

## 6. Evidence ledger fields

For each scenario record: environment name and account; resource identifiers (non-secret); exact source commit and deployed Worker version; migration names/checksums; Access application/policy revision; test case and synthetic tenant IDs; timestamp; sanitized request ID; expected and observed result; logs/audit references with sensitive values redacted; operator; independent reviewer; pass/fail; issue reference; and rollback/cleanup confirmation.

**Current decision: NO-GO for staging provisioning or deployment.** Continue with source-level review and test hardening only until prerequisites are verified and the required approvals exist.
