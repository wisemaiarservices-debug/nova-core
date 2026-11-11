# NOVA Core tenant isolation and authorization contract (V1)

**Status:** design contract only. This document does not claim that tenant authentication, authorization, row-level isolation, or production enforcement is implemented.

## 1. Security objective

Every customer-owned configuration, site, asset, source, observation, experiment, dataset attachment, and audit event must be accessible only through an authenticated principal with an explicit grant for that tenant and resource. A caller must never gain access by choosing or guessing a tenant_id, site_id, source ID, or asset ID.

The default is **deny**. Missing identity, membership, resource ownership, permission, or provenance is not interpreted as permission.

## 2. Trust boundaries

1. **External identity:** a verified identity token establishes a principal, not a tenant entitlement.
2. **Tenant membership:** a server-controlled membership registry establishes which tenant(s) a principal may access and with which role.
3. **Resource authorization:** the server resolves each requested resource under the authorized tenant scope and checks the requested action.
4. **Persistence:** every read and write is constrained by tenant scope in the data-access layer. Cloudflare D1 does not provide native row-level security; application-level scoping must therefore be centralized, mandatory, and covered by adversarial tests.
5. **Module integrations:** NeoAgro, NeoGrid, NeoCell, NOVA OS, and ingestion producers receive only the minimum tenant/resource grants required for their function. A module's declared capability is not proof of user or device authorization.

## 3. Principal verification requirements

For any future authenticated API route, validate the token signature using the configured trusted issuer keys and enforce:

- Exact issuer and audience allowlists; reject algorithm substitution and unsigned tokens.
- Valid exp, nbf, and bounded clock skew; reject expired, not-yet-valid, malformed, or oversized tokens.
- Expected token class and authorized client/application where applicable; do not accept an end-user token as a machine credential or vice versa.
- Key rotation and bounded JWKS caching; fail closed when verification cannot be completed safely.
- Stable subject identifier from the verified token. Email, display name, request headers, and client-provided tenant fields are not authorization identities.
- No token, secret, authorization header, or private claim values in logs.

Cloudflare Access JWT verification on the protected ingestion Worker is a transport identity check only. It must not be treated as proof of tenant membership unless a separately verified, explicit tenant/source grant is resolved.

## 4. Membership and role model

Membership is server-owned and tenant-scoped. Suggested V1 roles:

| Role | Allowed scope |
|---|---|
| tenant_owner | Manage tenant membership and tenant configuration; no cross-tenant access |
| tenant_admin | Manage sites, equipment, sources, and approved integrations within one tenant |
| operator | Read operational data and submit observations for explicitly granted sites/sources |
| analyst | Read permitted observations, provenance, and experiment results; no ingestion or configuration writes |
| viewer | Read-only access to explicitly granted tenant resources |
| service | Machine-to-machine access limited to named tenant, source, module, and permitted actions |

Role names alone are not sufficient. Grants must be checked against the requested resource and action. No implicit global administrator role is introduced by this contract; any platform-operator access requires a separate, audited break-glass process.

## 5. Resource-scoping rules

- Resolve tenant identity from the verified principal's server-side membership, not from request body, query parameters, URL fragments, local storage, or caller-supplied headers.
- If a route accepts a tenant or site identifier, treat it only as a resource selector and verify it against the authenticated grant.
- Every repository operation must require an explicit authorized tenant context. Avoid unscoped get_by_id(id) methods for tenant-owned records.
- Queries must include tenant predicates at the data-access boundary, not only in route handlers.
- Enforce tenant-aware foreign keys and uniqueness where supported, for example (tenant_id, site_id) and (tenant_id, source_id).
- Verify ownership of every referenced site, asset, source, experiment, and dataset before joining or mutating.
- Scope idempotency keys by tenant and producer/source. A key collision across tenants must never reveal or overwrite another tenant's result.
- Use transactions for observation plus audit-event writes. A failed audit write must not leave an untraceable accepted observation.
- Return a consistent not-found/denied response policy that does not disclose whether another tenant owns a guessed identifier.
- Public scientific provider endpoints may return provider data, but must not expose customer-specific configuration or observations.

## 6. Ingestion producer authorization

A service credential must be independently bound to:

- one tenant;
- one or more registered source IDs;
- an allowed module/producer identity;
- an explicit set of actions (normally append observations only);
- optional site and metric restrictions;
- expiry, revocation state, and credential version.

The producer cannot self-register a tenant, site, source, or verification status. The server assigns receipt timestamps and verification state. An observation remains unverified until source identity, schema, units, timestamp, quality rules, and authorization have passed their respective checks. Device capability declarations do not imply device identity or connectivity.

## 7. Data rights and model governance

- Tenant data is isolated by default. Cross-tenant pooling, fine-tuning, benchmarking, or disclosure requires an explicit documented legal basis and opt-in/contractual authorization.
- Customer-specific calibration and configuration remain tenant-scoped. They must not silently mutate global model parameters.
- Data export, deletion, retention, and audit access require tenant-scoped authorization and traceable execution.
- Model and experiment records must retain dataset/version/hash lineage and applicable tenant/data-rights scope.
- Model applicability checks and abstention remain mandatory after authorization; authorization does not make a model scientifically valid.

## 8. Required adversarial acceptance tests before any tenant API is exposed

1. Anonymous, malformed, expired, wrong-issuer, wrong-audience, wrong-algorithm, and wrong-token-class requests are denied.
2. A valid principal without tenant membership is denied.
3. A tenant A principal cannot read, mutate, enumerate, infer existence of, or attach tenant B resources by changing IDs, paths, query parameters, headers, or request bodies.
4. A service credential for source A cannot ingest for source B, site B, another module, or another tenant.
5. Cross-tenant foreign-key references and idempotency-key collisions are rejected without leaking records.
6. Every read, write, export, delete, and administrative mutation is tenant-scoped and audited.
7. Revoked memberships and credentials take effect within a documented bounded interval.
8. Concurrent writes preserve tenant boundaries and atomic observation/audit semantics.
9. Property-based tests generate mismatched tenant/resource combinations across every repository method.
10. A repository-level test fails if a tenant-owned query can execute without an authorized tenant context.

## 9. Implementation sequence and release gate

1. Define principal and membership schemas plus migrations; do not create production D1 resources without explicit approval.
2. Implement a single token-verification adapter with issuer/audience configuration and key rotation.
3. Implement a central authorization context and deny-by-default policy evaluator.
4. Make tenant-scoped repository interfaces mandatory; remove or prohibit unscoped tenant-owned lookups.
5. Bind ingestion service credentials to tenant/source/module/action grants.
6. Add adversarial integration tests and security review before exposing any tenant configuration, capability assessment, observation, or experiment endpoint.
7. Only then add authenticated API routes for the unified client capability assessment.

**Release blocker:** PR #34's unified capability assessment is an in-memory composition helper. It must not be exposed through a public API or connected to customer persistence until the controls and tests above are implemented and independently reviewed.

## 10. Current implementation status

This PR adds only the security contract and acceptance criteria. It does not add authentication, authorization code, migrations, D1 bindings, credentials, tenant records, API routes, or production deployment. No customer or pilot site is assumed.
