# NOVA V1 owner-authorization staging validation runbook

**Status:** staging-only execution plan. This document does not authorize production configuration, customer onboarding, migration, or deployment. The coordinated runtime review set remains draft in NOVA OS PR #57, integrated authorization/mapping PR #60, follow-up nonce-ordering PR #61, and combined NOVA Core integration PR #227. Core PR #227 combines provisioning PR #222 with protected-read PRs #223–#226. PR #61 is stacked on #60 and must not be staged independently; PR #59 is closed/superseded.

## 1. Preconditions

- Use isolated staging projects/accounts and disposable tenant data only.
- Confirm NOVA OS PRs #57, #60 and #61 and combined Core PR #227 are reviewed and integrated to coordinated staging branches; verify migration/workflow checks pass at the exact deployed commits. Do not stage the #57 owner-authorization endpoint without #60's independent nonce-reservation and consumed-permit mapping protections plus #61's pre-parse nonce reservation.
- Confirm a named staging operator, independent reviewer, rollback owner, and incident contact.
- Record the exact OS and Core commit SHAs, migration versions, worker/function versions, deployment timestamps, and test run IDs.
- Verify the staging Cloudflare Access application, Supabase project, NOVA OS Edge Functions, and NOVA Core Worker are distinct from production.
- No production tenant, production credential, or real customer data may be used.

## 1A. Cross-repository code-validation baseline

The following exact heads and checks were re-fetched on 2026-11-17. They are repository CI evidence only, not staging deployment or end-to-end evidence. Re-fetch every head and required check immediately before staging; any changed head requires a fresh coordinated review and CI.

- NOVA OS PR #57 authorization implementation: head `110116d844ed73e46ee85d3508c4bac740cd6230`, based on protocol branch base `561fcfb1d05ae62c2b70c6d91a9267e58da242c2`. Tenant migration validation [run 43973754344](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/43973754344) and tenant administration validation [run 43973754374](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/43973754374) passed.
- NOVA OS PR #60 integrated nonce-reservation and consumed-permit mapping: head `17f6c9dc590693e53bd534849192b0daf71aa030`, based on PR #57 head above. Tenant migration validation [run 44078094385](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44078094385) and tenant administration validation [run 44078094194](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44078094194) passed.
- NOVA OS PR #61 pre-parse authenticated-nonce reservation: runtime code head `dfbc6747fa5b418dc6665962ea94ac3917d4134c`, based on PR #60 head above. Tenant migration validation [run 44169408597](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44169408597) and tenant administration validation [run 44169408610](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44169408610) passed. Documentation-only follow-ups are at current PR head `2b6da562cdb1df354e04d6969ca2d54b646914e3` (including the prior owner-assertion JWK checklist commit `62abce7d32ea74d730342f8a4f5aa52a017a3e9f`); runtime code is unchanged. The endpoint reserves a nonce after valid HMAC verification and bounded body read, before JSON parsing, payload validation, owner-assertion verification or durable authorization consumption. Invalid authenticated payloads/assertions therefore require a fresh HMAC nonce/timestamp/signature on retry.
- NOVA Core protocol PR #221: head `285d53d0bbc5e40f64f8eadcccdc025050024af2`; CI [run 43948195993](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/43948195993) passed.
- NOVA Core provisioning source PR #222: exact current head `010d88799afed10eb1133f47120cfcd17d58b36d`, based on protocol PR #221 head above. Exact-head CI [run 44170266058](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44170266058) passed all three jobs (API tests, tenant Worker/D1 integration, research raster tests). The combined integration candidate is PR #227 below.
- OS PR #56 and runtime PR #57 are sibling review branches, not a strict base/head dependency. Review their protocol contracts together. OS PR #60 depends on the exact #57 head above. Core PR #222 depends on the exact #221 head above.
- The coordinated runtime review set is OS #57 + OS #60 + OS #61 + Core #227, with protocol specifications #56 and #221 reviewed alongside them. Core #227 is the combined candidate based on the #223–#226 protected-read stack and includes provisioning source PR #222. PR #61 is stacked on #60 and must not be staged independently; PR #59 is closed/superseded. Re-fetch all exact heads, base relationships, migration order, and checks immediately before staging.
## 2. Configuration inventory (names only; never put values in this file)

### NOVA OS Supabase Edge Function: `nova-core-owner-authorization`

Provision through the staging Supabase secret manager. Confirm `supabase/config.toml` has `verify_jwt = false` for this function: the function authenticates the Core caller with its timestamped HMAC signature and nonce ledger, not a browser Supabase bearer token. Keep the function private operationally and do not add permissive CORS:

- `NOVA_CORE_OWNER_AUTH_KEYS` — JSON object mapping a key ID to a dedicated random HMAC secret (32–512 characters). This is the verifier side of the Core-to-OS server authentication.
- `NOVA_OS_PROVISIONING_AUTH_ISSUER`
- `NOVA_OS_PROVISIONING_AUTH_AUDIENCE`
- `NOVA_OS_PROVISIONING_AUTH_JWK` — public JWK only, matching the NOVA OS owner-assertion signing key.
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_ISSUER`
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_AUDIENCE`
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_KEY_ID`
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_PRIVATE_KEY` — dedicated staging RS256 private key, PKCS#8 PEM; never expose to Core or browser.

Existing Supabase platform configuration is also required by the function: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Keep the service-role key inside Supabase's server-side secret store; it is used only for the narrow server-side RPC call and must never be reused as the Core-to-OS HMAC credential.

### NOVA OS owner-assertion issuance and mapping functions

The browser-facing owner-assertion issuer and mapping function have separate configuration from the private Core-to-OS authorization endpoint. Verify each exact function name and staging config before deployment.

Owner assertion issuer (nova-core-provisioning-owner-assertion):
- NOVA_OS_ALLOWED_ORIGINS — exact HTTPS browser-origin allowlist; no wildcard.
- NOVA_OS_PROVISIONING_AUTH_ISSUER and NOVA_OS_PROVISIONING_AUTH_AUDIENCE.
- NOVA_OS_PROVISIONING_AUTH_KEY_ID and NOVA_OS_PROVISIONING_AUTH_PRIVATE_KEY — dedicated OS staging RS256 signing key; private key stays in OS secret storage.
- SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY — staging project only.

Core receipt mapping (nova-core-tenant-mapping):
- NOVA_OS_ALLOWED_ORIGINS — exact HTTPS browser-origin allowlist; no wildcard.
- NOVA_CORE_MAPPING_RECEIPT_ISSUER and NOVA_CORE_MAPPING_RECEIPT_AUDIENCE.
- NOVA_CORE_MAPPING_RECEIPT_JWK — public JWK matching the Core receipt-signing key.
- SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY — staging project only.

The Core provisioning owner-assertion verification JWK and the private authorization endpoint's NOVA_OS_PROVISIONING_AUTH_JWK must match the public key corresponding to the OS assertion issuer's signing key. The Core receipt signer private key must never be copied to NOVA OS; only its public JWK is configured there.

### NOVA Core Worker

Provision through the staging Worker secret/configuration mechanism:

- `NOVA_OS_OWNER_AUTHORIZATION_URL` — exact staging function URL ending `/functions/v1/nova-core-owner-authorization`.
- `NOVA_OS_OWNER_AUTH_KEYS` — JSON object with the same key-ID-to-HMAC-secret mapping as the OS verifier.
- `NOVA_OS_OWNER_AUTH_ACTIVE_KEY_ID` — active key ID present in that JSON object.
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_ISSUER`
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_AUDIENCE`
- `NOVA_OS_OWNER_AUTHORIZATION_PERMIT_JWK` — public JWK only, matching the OS permit signing key and key ID.

Additional required Core Worker configuration:
- SUPABASE_AUTH_ISSUER and SUPABASE_AUTH_AUDIENCE — exact staging Supabase JWT issuer and audience.
- NOVA_OS_PROVISIONING_AUTH_ISSUER, NOVA_OS_PROVISIONING_AUTH_AUDIENCE and NOVA_OS_PROVISIONING_AUTH_JWK — verify the OS owner assertion; the JWK is public and must match the OS issuer key.
- NOVA_OS_MAPPING_RECEIPT_ISSUER, NOVA_OS_MAPPING_RECEIPT_AUDIENCE and NOVA_OS_MAPPING_RECEIPT_KEY_ID.
- NOVA_OS_MAPPING_RECEIPT_PRIVATE_KEY — Core's dedicated staging PKCS#8 receipt-signing key, server-side only; NOVA OS receives only its public JWK.
- ACCESS_ISSUER and ACCESS_AUDIENCE — exact Cloudflare Access identity contract.
- TENANT_PROVISIONING_SUBJECTS — staging-only allowlist of permitted provisioning subjects.
- INTERNAL_AUTH_SECRET — server-side private Worker/gateway authentication secret where required by the deployment topology.
- DB — staging D1 binding, not production.

Do not copy private keys into public JWK settings, browser variables, build-time client bundles, logs, repository files, or CI artifacts.

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

## 1C. Static security-review observations (not staging evidence)

- The OS authorization-consumption RPC and the tenant membership-administration RPC both lock the tenant row before the owner/membership row. This matches the intended serialization order for concurrent owner revocation and authorization consumption; staging must still execute the two-session race tests.
- The OS HMAC nonce reservation is a separate RPC transaction invoked after request-signature verification and bounded body read, but before JSON parsing or owner-assertion verification (PR #61). The consume RPC requires the exact nonce/timestamp reservation to exist and be unexpired. The nonce table has forced RLS, direct table privileges are revoked, and the service role is granted RPC execution rather than direct table access.
- The OS mapping RPC binds the mapping event to the exact consumed permit and request tuple. It does not reactivate the OS tenant or grant OS access. Core protected-read authorization remains a separate gate.
- These observations are source-level review only. They do not prove deployed database ownership, secret custody, staging behavior, external penetration-test results, or production readiness.

## 6. Required end-to-end test matrix

Use fresh disposable tenant identities for each case. Capture only request IDs, correlation IDs, commit SHAs, status codes, and redacted audit evidence.

1. **Happy path:** active owner + valid Access and Supabase identities; one Core tenant, one owner membership, expected tenant grants, one durable provisioning request, one OS consumption row, one permit-bound mapping event.
2. **Owner revoked before consumption:** endpoint denies; Core creates zero tenant, membership, grants, provisioning request, or audit rows.
3. **Concurrent revocation wins:** the PostgreSQL two-session test proves consume fails if revocation obtains the tenant/member lock first.
4. **Consumption wins:** the exact authorized attempt completes if consumption commits first; a later owner revocation does not create a duplicate or invalidate that already-consumed permit.
5. **Suspended tenant:** new authorization consumption fails. If the tenant is suspended after consumption but before mapping, the exact consumed permit may complete identity mapping. Assert that the NOVA OS tenant remains suspended and mapping does not reactivate it. Separately confirm that Core protected reads remain blocked until the independent identity-link approval and Core membership/site-grant checks succeed; mapping itself grants neither.
6. **Bad HMAC:** wrong key ID, signature, timestamp, path, body digest, or replayed nonce is rejected.
6A. **Authenticated malformed request nonce consumption:** send validly HMAC-signed requests with malformed JSON, invalid payload claims, and invalid/expired owner assertions in separate disposable attempts. Each request nonce must be durably consumed before parsing/authorization; replaying the same signed request must fail. A retry must use a fresh HMAC nonce/timestamp/signature and must still obey the durable owner-authorization ledger's exact-replay rules. Confirm unauthenticated, invalid-signature, stale-timestamp, wrong-method/content-type and oversized requests do not reserve a nonce.
7. **Bad permit:** wrong key, issuer, audience, expiry, tenant, actor, Supabase identity, Access identity, assertion JTI, idempotency key, digest, correlation ID, or permit JTI fails before Core writes.
8. **Concurrent exact retry:** submit two identical requests concurrently. Both may receive separately signed permits with the same durable permit JTI and different token timestamps; Core must persist one tenant/provisioning row and resolve the losing request to that same result.
9. **Changed retry:** same assertion/idempotency identity with changed request claims returns conflict and creates no second tenant.
10. **Lost response after OS consume but before Core commit:** exact retry only; no altered request may reuse the consumed authorization.
11. **Core committed but mapping receipt response lost, followed by owner/tenant suspension or provisioning-allowlist removal:** exact retry reissues a receipt with the original durable Core request and consumed permit identity. It must not require current owner/admin status or current allowlist membership, create a second tenant, issue a new OS permit, reactivate either tenant, or restore access. Confirm NOVA OS maps only the exact consumed tuple.
12. **Lost response after Core commit:** Core resolves the existing durable request before a new OS exchange and returns the same Core tenant/receipt identity.
13. **Mapping retry:** exact receipt/permit retry is idempotent; a changed tenant, actor, receipt, permit, or digest is rejected.
14. **Isolation:** a different tenant, owner, Access subject, or Supabase subject cannot read or mutate another tenant's records.
15. **Database privilege boundary:** using browser roles and the service role directly, verify there is no direct SELECT/INSERT/UPDATE/DELETE/TRUNCATE access to owner-consumption, nonce, or authorization-event ledgers; only the narrowly scoped RPCs can perform their intended operations. Verify UPDATE/DELETE against immutable consumption and authorization-event rows fail, and verify the mapping event's append-only protections and exact-tenant uniqueness from its defining migration. Record role-level SQL results without exposing secrets.
16. **Secrets hygiene:** scan staging logs, browser bundles, Worker output, function logs, CI artifacts and repository diff for credentials or private key material.

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

## 1B. Required branch dependency and integration order

The runtime pull requests are based on prerequisite protocol branches. Preserve this dependency chain when preparing coordinated staging branches; do not merge a child PR against an unintegrated parent:

- NOVA OS protocol PR #56 (`design/nova-os-one-time-owner-authorization-v1`) and runtime PR #57 (`feat/nova-os-one-time-owner-authorization-v1`) are **sibling review branches**, not a strict base/head dependency: PR #56 head is `250d34e90435bc5d83cd3f0d80ce708f49cf27ec`, while PR #57 is based on `561fcfb1d05ae62c2b70c6d91a9267e58da242c2`. PR #57 includes its own runtime-aligned edits to the protocol document. Review both contracts together; do not claim PR #57 inherits PR #56's exact commit unless its base is deliberately updated and all affected checks rerun.
- NOVA OS PR #60 (`fix/nova-os-hmac-nonce-independent-reservation`) is based on PR #57 head `110116d844ed73e46ee85d3508c4bac740cd6230` and integrates the consumed-permit mapping correction formerly in PR #59. Preserve this dependency and re-run all exact-head checks after any update.
- NOVA Core protocol PR #221 (`design/nova-os-one-time-owner-authorization-v1`) → runtime PR #222 (`feat/nova-core-one-time-owner-authorization-v1`) is a true base/head dependency; PR #222 is based on PR #221 head `285d53d0bbc5e40f64f8eadcccdc025050024af2`.
- Before integration, verify every PR's current base SHA and head SHA against the reviewed values. If a parent changes, update/rebase dependent branches and rerun all affected checks.
- The two repositories can be integrated independently into isolated staging branches, but staging deployment must wait until both repository review sets are complete and their exact deployed SHAs are recorded.
- Keep protocol and runtime changes reviewable as separate units. A successful child CI run does not replace review of its parent contract or prove the combined deployment.
- Do not merge these branches directly to production as part of staging preparation.


## 9A. Staging release packet template

Use [NOVA_V1_STAGING_RELEASE_PACKET_TEMPLATE.md](./NOVA_V1_STAGING_RELEASE_PACKET_TEMPLATE.md) as the controlled evidence record when an authorized staging window is approved. It captures exact source SHAs, migration inventory, redacted configuration/key fingerprints, independent reviewers, E2E evidence, database privilege checks, stop conditions, rollback/recovery and sign-offs. It is a blank template; no operator, staging project, secret, pilot site or approval is pre-populated.

## 9. Combined Core provisioning and protected-read integration candidate

The protected-read and one-time owner-provisioning code has now been combined in draft Core PR [#227](https://github.com/wisemaiarservices-debug/nova-core/pull/227):

- Base: protected-read PR #226 exact head `d37e678921c73fb231a5831336f0dee51cce1275`, which includes the #223 → #224 → #225 → #226 stack.
- Provisioning source: PR #222 exact head `010d88799afed10eb1133f47120cfcd17d58b36d`.
- Combined integration code head: `1ebd32b3d00eba608b8407d44848b12ae067c73a`. The latest code-bearing/documentation-validated head is `8c1aa2637c804c32830ffa78e3925abb21073d68`; the current PR #227 head after subsequent documentation-only updates is `d6dd23e686dba83dccb8b1a1a06bbacf535a9c29`.
- Three shared files were merged from common ancestor `6cc1b3962b2d432a2876fdf5a440f9da5ac05cc8` with no conflicting hunks: `apps/api/tests/test_tenant_api_sql_contract.py`, `apps/tenant-api/src/index.mjs`, and `apps/tenant-api/test/tenant-api.test.mjs`.
- The resulting tree contains the complete provisioning migration/client/tests and the full protected-read code/tests from #223–#226. Source PRs remain open/draft and unchanged.
- Exact combined-code-head Core CI [run 44171368921](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44171368921) passed all three jobs. The latest code-bearing head `8c1aa2637c804c32830ffa78e3925abb21073d68` passed exact-head CI [run 44172052028](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44172052028), all three jobs: API tests, ordered disposable D1 migrations, SQL preparation, isolated fixtures, gateway/private Worker integration, and research raster tests. The later runbook/template commits are documentation-only and did not alter runtime code or migrations.

The combined Core source candidate's code was validated by exact-head CI at `8c1aa2637c804c32830ffa78e3925abb21073d68` (run 44172052028). Subsequent changes to this integration branch are documentation-only: runbook refresh commit `b3324c3a772d271fc6030902f0d339d427acf961` and release-packet template commit `314ff46b8ef34a6afb45860f29e3cf0dfdfc60d2`. No runtime source or migration changed in those commits. This does **not** constitute deployed cross-repository staging E2E or production readiness.

Before staging, require:
1. Coordinated OS PRs #57 + #60 + #61 and Core PR #227 to be reviewed and integrated using exact recorded SHAs.
2. Approved staging secrets/configuration: dedicated Core-to-OS HMAC key ring, OS permit signing key, pinned Core public JWK, exact issuer/audience and endpoint URLs, Cloudflare Access configuration and Core provisioning allowlist.
3. Ordered OS and Core migrations applied only to disposable/staging databases after backup/rollback review.
4. Cross-repository staging E2E covering first consume, pre-consume owner revocation, concurrent consume/revoke race, malformed authenticated request nonce replay, expired exact retry, lost Core response recovery, mapping after post-consume suspension, and protected reads after identity-link/membership/grant revocation.
5. Independent verification that no browser role or general service-role path can read/write authorization ledgers, private keys or mapping records outside the narrow RPC boundaries.
6. Human-approved pilot site, data rights, privacy, and recovery procedure before any customer data is used.

Until these gates pass, no production configuration, migrations, deployment, customer provisioning, or customer data access is authorized. This runbook records implementation and disposable-CI evidence only.


## 10. Follow-up Core response-boundary hardening

Core PR #228 (`fix/core-bound-owner-authorization-response`) is a draft child of the combined Core PR #227 integration branch. It changes the private NOVA OS authorization response reader to enforce a 16 KiB byte cap while streaming, reject malformed/oversized declared lengths before reading, cancel oversized streams, and decode UTF-8 strictly.

- PR #228 exact head: `46ca757c110313270f7212dab91a933dbdb47e44`.
- Exact-head Core CI [run 44189340065](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44189340065) passed all three jobs: API tests, tenant Worker/D1 integration (including ordered migrations, SQL preparation, isolated fixtures and gateway/private Worker Service Bindings E2E), and research raster tests.
- Focused tests cover oversized streaming and cancellation, oversized and malformed Content-Length rejection before body read, and acceptance at exactly 16 KiB.
- This is disposable CI evidence only. PR #228 remains draft/unmerged and must be included in the coordinated Core review/integration SHA if selected for staging. Re-fetch its head/base and checks before any staging change.
- No staging configuration, secret, migration, deployment or customer data operation is authorized by this follow-up.


---

## 11. Current coordinated candidate baseline (2026-11-17)

This addendum supersedes earlier references in this runbook that name Core #227 as the consolidated Core staging candidate or #228 as a separate candidate layer. Historical source-PR details remain for traceability. Re-fetch exact refs and checks immediately before any authorized staging action.

### NOVA Core consolidated candidate

- [PR #229](https://github.com/wisemaiarservices-debug/nova-core/pull/229), branch `integration/core-provisioning-protected-reads-bounded-response-v1`, exact head `8063ad968f6af50874b733186385fc7493b2cbfd`.
- It combines the Core provisioning/protected-read tree from #227 with the bounded streaming response reader and regression tests from #228.
- It is based on protected-read PR #226 head `d37e678921c73fb231a5831336f0dee51cce1275`. Therefore #226 and its parent stack #223–#225 remain prerequisites; #229 does not remove that base dependency.
- Exact-head Core CI [run 44190571076](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44190571076) completed successfully, all 3 jobs: API/security tests, research raster tests, and Tenant Worker/D1 integration with ordered migrations, query preparation, isolated fixtures and gateway/private Worker end-to-end.
- #229 is draft/open/unmerged. #227 and #228 remain open/draft source PRs. Do not deploy an intermediate source branch instead of the reviewed consolidated SHA.

### NOVA OS dependency chain

- OS #57 head `110116d844ed73e46ee85d3508c4bac740cd6230`: migration run [43973754344](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/43973754344) and administration run [43973754374](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/43973754374) passed.
- OS #60 head `17f6c9dc590693e53bd534849192b0daf71aa030`, based on #57: migration run [44078094385](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44078094385) and administration run [44078094194](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44078094194) passed.
- OS #61 latest head `2b6da562cdb1df354e04d6969ca2d54b646914e3`, based on #60: runtime code head `dfbc6747fa5b418dc6665962ea94ac3917d4134c` passed migration [44169408597](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44169408597) and administration [44169408610](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44169408610); latest documentation head passed migration [44173340563](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44173340563) and administration [44173340728](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44173340728).
- Preserve #57 → #60 → #61 as a strict stack. All remain draft/open/unmerged and must be reviewed together.

### Gate status

Automated source-branch CI is green for the current candidate heads described above. Independent security review, base-stack integration, deployed staging configuration/key custody, live cross-repository E2E, migration/rollback rehearsal, pilot/data-rights approval and explicit staging authorization are not complete. CI is not staging evidence. Production remains blocked; no secrets, migrations, deployments, tenant provisioning or customer-data access were performed.
