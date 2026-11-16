# NOVA V1 owner-authorization staging validation runbook

**Status:** staging-only execution plan. This document does not authorize production configuration, customer onboarding, migration, or deployment. The coordinated runtime changes remain draft in NOVA OS PR #57 and NOVA Core PR #222.

## 1. Preconditions

- Use isolated staging projects/accounts and disposable tenant data only.
- Confirm both PRs are reviewed, merged to coordinated staging branches, and their migration/workflow checks pass at the exact deployed commits.
- Confirm a named staging operator, independent reviewer, rollback owner, and incident contact.
- Record the exact OS and Core commit SHAs, migration versions, worker/function versions, deployment timestamps, and test run IDs.
- Verify the staging Cloudflare Access application, Supabase project, NOVA OS Edge Functions, and NOVA Core Worker are distinct from production.
- No production tenant, production credential, or real customer data may be used.

## 2. Configuration inventory (names only; never put values in this file)

### NOVA OS Supabase Edge Function: `nova-core-owner-authorization`

Provision through the staging Supabase secret manager:

- `NOVA_CORE_OWNER_AUTH_KEYS` — JSON object mapping a key ID to a dedicated random HMAC secret (32–512 characters). This is the verifier side of the Core-to-OS server authentication.
- `NOVA_OS_PROVISIONING_AUTH_ISSUER`
- `NOVA_OS_PROVISIONING_AUTH_AUDIENCE`
- `NOVA_OS_PROVISIONING_AUTH_JWK` — public JWK only, matching the NOVA OS owner-assertion signing key.
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_ISSUER`
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_AUDIENCE`
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_KEY_ID`
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_PRIVATE_KEY` — dedicated staging RS256 private key, PKCS#8 PEM; never expose to Core or browser.

Existing Supabase platform configuration is also required by the function: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Keep the service-role key inside Supabase's server-side secret store; it is used only for the narrow server-side RPC call and must never be reused as the Core-to-OS HMAC credential.

### NOVA Core Worker

Provision through the staging Worker secret/configuration mechanism:

- `NOVA_OS_OWNER_AUTHORIZATION_URL` — exact staging function URL ending `/functions/v1/nova-core-owner-authorization`.
- `NOVA_OS_OWNER_AUTH_KEYS` — JSON object with the same key-ID-to-HMAC-secret mapping as the OS verifier.
- `NOVA_OS_OWNER_AUTH_ACTIVE_KEY_ID` — active key ID present in that JSON object.
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_ISSUER`
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_AUDIENCE`
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_JWK` — public JWK only, matching the OS permit signing key and key ID.

Existing staging owner-assertion verification and Core mapping-receipt signing configuration must also be present and independently pinned. Do not copy private keys into public JWK settings, browser variables, build-time client bundles, logs, repository files, or CI artifacts.

## 3. HMAC server-identity setup and rotation

1. Generate a unique cryptographically random staging HMAC secret of at least 32 characters. Do not reuse a Supabase service-role key, Access token, owner assertion key, permit signing key, or production secret.
2. Assign a non-secret key ID. Store the same key-ID/secret mapping in the OS and Core server-side secret stores.
3. Configure Core's active key ID to the matching entry. The request signature binds method, exact path, key ID, timestamp, nonce, and SHA-256 body digest.
4. Confirm clock synchronization. The verifier rejects timestamps outside its 120-second acceptance window and the database nonce ledger prevents replay.
5. Rotation: add a new key ID and secret to the OS verifier map; deploy/confirm the verifier; switch Core's active key ID; validate successful staging requests; only then remove the previous key. Keep overlap short and documented.
6. Revoke a compromised key immediately from the OS verifier map and Core configuration. Expect provisioning to fail closed until both sides agree.

## 4. Permit signing-key setup and rotation

1. Generate a dedicated staging RS256 key pair. Store the PKCS#8 private key only in the NOVA OS secret store.
2. Publish only the corresponding public JWK to Core's pinned `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_JWK` setting. Verify the JWK `kid`, algorithm, modulus size, issuer and audience match exactly.
3. Set identical permit issuer/audience values on OS and Core. Use distinct staging identifiers, not production values.
4. Current verifier configuration pins a single permit JWK. Treat signing-key rotation as a coordinated cutover: stage and verify the new public JWK, then update OS signer key ID/private key and Core's pinned JWK in a controlled window. If both sides cannot be switched consistently, stop provisioning; do not weaken verification or accept token-directed keys.
5. Validate a new permit and a deliberately wrong-key permit. The latter must fail before any Core tenant write. Record the key ID and fingerprints only; never record key material.

## 5. Ordered staging migrations and deployment

- Apply the NOVA OS migrations in repository order in the isolated staging Supabase project, including the one-time authorization-consumption ledger and permit-bound mapping migration.
- Confirm migration history and database constraints/RPC grants before deploying the Edge Function.
- Deploy the NOVA OS function only after its secrets and public-key pins are independently reviewed.
- Apply NOVA Core migration `0034_nova_os_owner_authorization_permit.sql` in the isolated staging D1 database through the approved migration process.
- Deploy the Core Worker only after its endpoint, HMAC key ID/map, permit issuer/audience and public JWK are configured.
- Do not enable any production route, production D1 binding, production Supabase function, or production custom domain as part of this runbook.

## 6. Required end-to-end test matrix

Use fresh disposable tenant identities for each case. Capture only request IDs, correlation IDs, commit SHAs, status codes, and redacted audit evidence.

1. **Happy path:** active owner + valid Access and Supabase identities; one Core tenant, one owner membership, expected tenant grants, one durable provisioning request, one OS consumption row, one permit-bound mapping event.
2. **Owner revoked before consumption:** endpoint denies; Core creates zero tenant, membership, grants, provisioning request, or audit rows.
3. **Concurrent revocation wins:** the PostgreSQL two-session test proves consume fails if revocation obtains the tenant/member lock first.
4. **Consumption wins:** the exact authorized attempt completes if consumption commits first; a later owner revocation does not create a duplicate or invalidate that already-consumed permit.
5. **Suspended tenant:** new authorization consumption fails. If the tenant is suspended after consumption but before mapping, the current mapping RPC rejects because the tenant must remain active; record the resulting Core tenant as unlinked and use the governed recovery procedure. Mapping must never reactivate the tenant or grant access. This timing remains a release-gate scenario.
6. **Bad HMAC:** wrong key ID, signature, timestamp, path, body digest, or replayed nonce is rejected.
7. **Bad permit:** wrong key, issuer, audience, expiry, tenant, actor, Supabase identity, Access identity, assertion JTI, idempotency key, digest, correlation ID, or permit JTI fails before Core writes.
8. **Changed retry:** same assertion/idempotency identity with changed request claims returns conflict and creates no second tenant.
9. **Lost response after OS consume but before Core commit:** exact retry only; no altered request may reuse the consumed authorization.
10. **Lost response after Core commit:** Core resolves the existing durable request before a new OS exchange and returns the same Core tenant/receipt identity.
11. **Mapping retry:** exact receipt/permit retry is idempotent; a changed tenant, actor, receipt, permit, or digest is rejected.
12. **Isolation:** a different tenant, owner, Access subject, or Supabase subject cannot read or mutate another tenant's records.
13. **Secrets hygiene:** scan staging logs, browser bundles, Worker output, function logs, CI artifacts and repository diff for credentials or private key material.

## 7. Acceptance evidence

The staging release packet must include:

- Exact OS/Core commit SHAs and migration versions.
- CI run links and end-to-end test results for every matrix item.
- Redacted configuration inventory showing names, issuer/audience values and key IDs (not secret values).
- Public JWK fingerprints and independent confirmation of private-key custody.
- Audit-row counts and correlation IDs proving one-time consume, one Core tenant and one mapping.
- Evidence that all negative tests produced zero unauthorized Core writes.
- Rollback rehearsal and documented recovery for any pre-existing/unlinked Core tenant.
- Independent security sign-off and explicit staging exit approval.

## 8. Stop conditions

Stop immediately and disable the staging provisioning path if any key/issuer/audience mismatch, unexpected tenant write, duplicate tenant, replay acceptance, cross-tenant read, private-key disclosure, ambiguous database state, or unexplained mapping discrepancy occurs. Preserve redacted evidence and resolve through a reviewed code/configuration change.

**Production remains blocked** until coordinated OS/Core review, staging acceptance, independent security sign-off, production key custody and rotation plan, monitoring/alerting, rollback rehearsal, and explicit release authorization are complete.
