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


## 12. Cross-repository static contract audit (2026-11-17)

A source-level consistency audit was performed against the exact current candidate refs. This is static inspection only; it is not a live OS↔Core staging handshake or independent security certification.

### Exact refs inspected

- Core #229: `8063ad968f6af50874b733186385fc7493b2cbfd`.
- OS #57: `110116d844ed73e46ee85d3508c4bac740cd6230`.
- OS #60: `17f6c9dc590693e53bd534849192b0daf71aa030`.
- OS #61: `2b6da562cdb1df354e04d6969ca2d54b646914e3` (includes later documentation commits; the nonce-before-parse runtime implementation is at `dfbc6747fa5b418dc6665962ea94ac3917d4134c`).

### Contracts cross-checked

- Core client and OS endpoint use POST to `/nova-core-owner-authorization`.
- Both sides canonicalize the HMAC input as method, path, key ID, timestamp, nonce and SHA-256 body digest, newline-delimited. OS verifies the configured key-ring entry and enforces the 120-second timestamp window and UUID nonce.
- OS `supabase/config.toml` disables Supabase JWT gateway verification for this private endpoint; the endpoint itself performs Core HMAC authentication. This does not make the endpoint public-authorized: requests still require the configured server HMAC.
- OS reserves an authenticated nonce in a separate committed RPC before JSON parsing, payload validation, owner-assertion verification and durable consumption. The consumption RPC requires that exact nonce/timestamp reservation.
- OS verifies the signed owner assertion against its configured issuer, audience and pinned public JWK, then binds tenant, Supabase issuer/subject, owner role/status and assertion JTI.
- The OS permit signer emits RS256 with configured permit issuer, audience and key ID. Core pins the corresponding public JWK and checks the header key ID, signature, issuer/audience, Access identity, Supabase identity, OS tenant, assertion JTI, idempotency key, request digest, correlation ID and bounded permit lifetime.
- Both sides use the deterministic correlation value `nova-provision:<request_sha256>`. OS persistence binds the exact owner attempt and consumed authorization; Core persists the permit identity with its durable provisioning request.
- Exact retry behavior is deliberately distinct from first use: expired owner assertions are only eligible for exact replay of an already-consumed authorization, never first consumption. New first-use consumption rechecks active tenant and owner under database locks.
- Core's response reader enforces a 16 KiB streamed response limit and strict UTF-8 decoding.

### Environment/key inventory to reconcile before staging

Core Worker configuration must supply the owner assertion verifier issuer/audience/JWK, the private OS authorization endpoint URL, the Core HMAC key ring and active key ID, and the permit issuer/audience/pinned public JWK. The OS Edge Function must supply the matching Core HMAC key ring, OS owner assertion issuer/audience/JWK, and permit issuer/audience/key ID/private signing key. The public permit JWK's `kid` must equal the OS signing key ID; the OS owner assertion JWK must correspond to the OS assertion signer. Values must be reconciled through a redacted, reviewer-approved inventory; no secret values belong in this document or Git.

### Remaining staging checks

- [ ] Verify the deployed OS owner-assertion signing key and public JWK match the Core-pinned owner assertion JWK.
- [ ] Verify the OS permit private key and Core-pinned permit public JWK are a matching pair with identical `kid`, issuer and audience.
- [ ] Verify the Core HMAC active key ID exists in the OS HMAC key ring and both sides use the same secret value, without exposing it in logs or review artifacts.
- [ ] Verify the actual migration ledger and order on a disposable staging clone, including OS tenant mapping, owner-attempt issuance, mapping receipt, owner authorization consumption, authorization-permit binding and nonce reservation.
- [ ] Execute live first-use, duplicate nonce, invalid signed payload, concurrent owner revoke/consume, exact expired replay, lost Core response, Core-commit/mapping-recovery and post-revocation protected-read scenarios.
- [ ] Record observed results, request correlation IDs and redacted evidence; do not treat source inspection or CI as a substitute.

The static audit found the source contracts aligned at the refs above. No deployed secrets, staging migrations, live requests, tenant provisioning, production configuration or customer-data operations were performed. Production remains blocked.


## 13. Migration preflight and recovery sequence audit (2026-11-17)

### Migration-order findings

The reviewed OS chain is timestamp-ordered and must be applied in order:

1. `20261116110000_nova_core_tenant_mapping.sql`
2. `20261116120000_nova_core_provisioning_attempts.sql`
3. `20261116130000_nova_core_tenant_mapping_receipts.sql`
4. `20261116140000_nova_core_mapping_audit_privileges.sql`
5. `20261116150000_nova_tenant_membership_admin.sql`
6. `20261116160000_nova_tenant_invitations.sql`
7. `20261116170000_nova_core_owner_assertion_issuance_guard.sql`
8. `20261116180000_nova_core_mapping_owner_assertion_binding.sql`
9. `20261116190000_nova_core_owner_authorization_consumption.sql`
10. `20261116191000_nova_core_mapping_authorization_permit_binding.sql`

Core migration `0034_nova_os_owner_authorization_permit.sql` follows Core migrations `0026`–`0033` in the Core migration ledger.

The OS migration at timestamp `20261116180000` adds a NOT NULL owner-assertion reference to existing mapping events after backfilling from `nova_core_provisioning_attempts`. It intentionally aborts if any historical mapping event cannot be matched on tenant, actor and idempotency key. Therefore a successful clean-database CI migration is not sufficient evidence that a populated staging database can migrate.

### Mandatory read-only OS preflight

Run against a read-only snapshot of the target staging database before applying migration `20261116180000`. This query uses only tables/columns created by the preceding migrations:

```sql
SELECT
  mapping.tenant_id,
  mapping.actor_user_id,
  mapping.idempotency_key,
  mapping.receipt_jti
FROM public.nova_core_tenant_mapping_events AS mapping
LEFT JOIN public.nova_core_provisioning_attempts AS attempt
  ON attempt.tenant_id = mapping.tenant_id
 AND attempt.actor_user_id = mapping.actor_user_id
 AND attempt.idempotency_key = mapping.idempotency_key
WHERE attempt.id IS NULL;
```

Expected result: zero rows. Any row is a hard stop; do not fabricate owner attempts, delete audit history, or weaken the migration. Escalate for a separately reviewed legacy-data reconciliation plan.

Also record counts before/after each migration for the tenant mapping, provisioning attempt/event, mapping receipt event and authorization ledger tables. Confirm no pre-existing mapping is silently reinterpreted as a newly consumed authorization. Migration `20261116191000` permits legacy mapping events to retain NULL permit/correlation fields as historical records, but the new mapping RPC requires the exact non-NULL permit and correlation tuple for new mappings.

### Recommended staging sequence

1. Take and verify a restorable staging backup; rehearse restoration separately.
2. Freeze provisioning and tenant-owner/membership lifecycle writes for the migration window.
3. Run the read-only compatibility query above and inspect the full migration ledger.
4. Apply the OS migrations in exact timestamp order to a disposable clone first, then to staging only after explicit staging authorization.
5. Apply Core migrations `0026`–`0034` in exact numeric order to a disposable clone first; verify the permit-binding triggers reject missing or malformed permit tuples.
6. Provision and verify the OS HMAC key ring, owner-assertion signer/public JWK and permit signer/Core-pinned public JWK through approved secret management. Reconcile issuer, audience and key IDs before enabling requests.
7. Deploy the OS private authorization endpoint and mapping Edge Function with the exact matching configuration; verify health/configuration without sending customer provisioning requests.
8. Deploy the Core Worker with the matching HMAC client, owner assertion verifier and permit verifier. Keep provisioning disabled until both sides' smoke tests and reviewer sign-off are complete.
9. Execute the approved staging E2E matrix and preserve redacted evidence. Re-enable provisioning only after explicit release approval.

This is a proposed safe order for review, not an authorization to execute it. Confirm actual deployment tooling and compatibility/rollback behavior with the release owner before use.

### Recovery semantics and stop conditions

- **OS nonce reserved, owner assertion invalid or request malformed:** the nonce remains consumed. Retry only with a fresh timestamp, nonce and HMAC signature. Never delete the nonce to permit replay.
- **OS authorization consumed, Core did not commit:** retry the exact original provisioning tuple. OS may accept the expired assertion only as an exact replay of the already-consumed authorization; a fresh first-use authorization still requires a valid assertion. Use a fresh HMAC nonce for every retry.
- **Core committed, response was lost:** Core must resolve the exact existing durable provisioning request and return its prior receipt without creating another tenant, obtaining a new OS permit, or reactivating access.
- **Core committed, OS mapping did not complete:** retry mapping with the same signed Core receipt and exact consumed permit tuple. The OS mapping transaction atomically writes the mapping event and tenant mapping. A changed tuple or different Core tenant is a conflict requiring incident review.
- **Owner or tenant suspended after OS authorization consumption:** mapping may complete from the immutable consumed permit because authorization linearized at consumption. Mapping does not reactivate the tenant or grant site/resource access. Subsequent protected operations must still enforce current membership and grants.
- **Migration or deployment partially completed:** stop new provisioning, preserve ledgers and logs, identify the last completed migration/deployment SHA, and use a reviewed forward-recovery or restore plan. Do not manually delete authorization, receipt, mapping or audit records; do not assume destructive down-migrations are safe.

### Evidence status

The source migrations were inspected at OS #61 head `2b6da562cdb1df354e04d6969ca2d54b646914e3` and Core #229 head `8063ad968f6af50874b733186385fc7493b2cbfd`. This review establishes source ordering and the legacy backfill precondition only. The target staging migration ledger, populated-data preflight, backup restore, live cross-repository recovery tests and staging approval remain outstanding. No staging or production database was queried or changed.


## 14. First-site and asset onboarding transaction/retry audit (2026-11-17)

### Source-level findings

Reviewed Core #229 source at `8063ad968f6af50874b733186385fc7493b2cbfd`:

- `apps/tenant-api/src/site-creation.mjs` creates a site, the exact owner's initial site-read grant, grant event, site-created event and immutable idempotency record in one D1 batch. The final idempotency row is guarded by the existence of the site event and matching read grant.
- `apps/tenant-api/src/asset-registration.mjs` creates an `unconfigured` asset, exact owner's initial asset-read grant, grant event, asset-created event and immutable idempotency record in one D1 batch. Composite tenant/site/asset scope is enforced by the migration constraints.
- Both operations look up the actor/tenant-scoped idempotency key before writing. An exact request digest returns the original resource; a changed digest conflicts. If a batch reports failure, the code checks for a committed idempotency record before deciding whether to return a replay or propagate the failure.
- The route layer requires the currently active tenant owner, active tenant and approved exact dual-identity link before first-site creation. Asset creation additionally requires the exact active site read grant. These checks also run before the idempotent helper is reached; replay is therefore not an authorization bypass.
- Site/asset events and creation-request records are append-only. Their migration triggers reject incomplete audit/grant/resource combinations.

### Recovery implications

D1 batch atomicity plus the final request-record guards prevents a partially committed site/asset setup from being reported as successful. A lost response can be recovered with the same idempotency key and body digest while the caller still satisfies the route's current authorization checks.

If the owner is suspended, the tenant is inactive, the dual-identity link is no longer approved, or (for assets) the site read grant is absent, the route denies the request before replay lookup. Do not bypass those checks to recover a response. First resolve the current authorization through the governed membership/identity/grant lifecycle, then retry the exact original request. Existing committed site/asset records and append-only events remain intact; do not delete them or create a replacement merely because the response was lost.

### Regression coverage inspected

- `site-creation.test.mjs`: atomic site/grant/audit/idempotency write, exact replay, digest conflict, malformed input, exact approved dual-identity pair, failed-batch handling.
- `asset-registration.test.mjs`: atomic unconfigured asset/grant/audit write, exact replay, digest/scope conflict, exact approved dual-identity pair, failed-batch handling.
- `site-creation-route.test.mjs`: linked active owner requirement, non-owner denial, unapproved identity denial, caller-supplied tenant/site field rejection.
- `asset-registration-route.test.mjs`: linked active owner and exact site grant requirement, denial of admin/unlinked/missing-grant cases.

These tests are included in the combined Core candidate's previously recorded exact runtime CI run `44190571076` (all three jobs passed). This source review does not establish live staging recovery behavior or verify a populated staging database.

### Release gate

Before enabling first-site or asset onboarding in staging, exercise (1) exact retry after a successful commit with response deliberately dropped, (2) changed-body retry under the same idempotency key, (3) induced batch failure before commit, and (4) owner suspension/identity-link revocation before retry. Verify the first and only first case returns the original resource when authorization remains active; all authorization failures remain denied. Capture redacted results and retain the original request key/digest securely for incident recovery.


## 15. Observation ingestion source-revocation race (2026-11-17)

### Finding

The ingestion Worker checks the source's `verification_status='verified'` during `resolveObservationOwnership`, then calls `persistObservation` in a separate D1 operation. Before this follow-up, the database observation insert guard enforced tenant/site/source ownership and active-tenant state, but did not recheck the source's current verification status or module at insert time. A source could therefore be revoked after the Worker lookup and before the observation insert.

### Remediation candidate

Core PR #231 adds migration `0035_observation_ingestion_requires_verified_source.sql`. Its `BEFORE INSERT` trigger rechecks active tenant, active site, exact tenant/source/module scope, verified source status and either exact site scope or an explicitly global source. This makes the database insert the final lifecycle authorization boundary; the Worker's early check remains useful for request rejection and clear error handling.

Regression tests cover unverified and disabled sources, verified source acceptance, revocation between early lookup and insert, explicitly global source behavior, module/tenant/site mismatch and inactive tenant/site. The SQL trigger was independently exercised against SQLite with the expected reject/accept behavior. Exact-head CI for PR #231 head `360905166e888ce005175b279175b4e28e6747f1` passed all three jobs in run `44193036471` (tenant Worker/D1 integration, API/security tests and research raster tests). This validates the tested branch state, not a staging deployment or migration application.

### Release gate

Treat PR #231 as a required dependency before enabling observation ingestion in staging. Apply migration `0035` only after the complete Core migration chain is validated on a disposable clone and the normal staging migration approval is recorded. Verify the actual Worker deployment is bound to the database containing the trigger. Do not claim the race is closed in any environment until the migration has been applied and the deployed Worker/database combination has passed the staging revocation-race test.

No staging or production database was queried or changed during this source audit.


## 16. Measurement-quality assessment source lifecycle recheck (2026-11-17)

### Finding

A second-order lifecycle gap remained after ingestion: measurement-quality assessment required a verified observation, exact verified sensor/source mapping, effective verified calibration and exact verified policy, but did not recheck the source's current lifecycle status. A previously verified observation could therefore receive a new assessment after its source had subsequently been disabled or revoked.

### Remediation candidate

Core PR #232 adds a live source check before creating a new assessment. It requires the exact source to remain verified, match the observation's tenant and module, be explicitly global or scoped to the observation site, and belong to an active tenant and active site. Otherwise the assessment is recorded as `not_assessed` with reason `source_not_active_or_verified`. Historical observations and already-created immutable assessment records are not rewritten; exact idempotent replay returns the original result rather than creating a new assessment.

Regression coverage includes revoked, disabled and unverified sources, wrong module and wrong site. PR #232 is stacked on PR #231. Exact-head CI passed at `0b6f6e64cd4382392a406ce9198cd603b5c50b15`: [run 44195702163](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44195702163), all three jobs successful (API/security, tenant Worker with disposable D1 migrations and gateway/private Worker integration, and research raster tests). This is repository CI evidence only, not staging E2E.

### Release gate

Treat PR #232 as a required dependency before enabling new measurement-quality assessments in staging. Exact-head CI is green; still exercise revocation after observation verification but before a new assessment. Confirm no new `passed` or `failed` assessment is created after source revocation. Historical assessment retrieval and exact idempotent replay must remain auditable and must not be represented as a newly performed assessment.

No staging or production database was queried or changed during this audit.


## 15. Sensor-to-source mapping approval lifecycle gate

Core PR #233 is stacked on PR #232 (which is stacked on #231). It prevents a mapping from being newly verified when its underlying source or mapped resources are no longer eligible.

- Exact PR #233 head: `bb901fe9cc4ef67ded575b2b8d34873a4085df1a`.
- Exact-head CI [run 44199420503](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44199420503) passed all three jobs: API/security tests, tenant Worker tests including disposable D1 migrations and gateway/private Worker integration, and research raster tests.
- A mapping's `verify` decision now requires the exact source to remain verified in the same tenant; source scope must be global or the exact mapping site; tenant and site must remain active; and the mapped asset must remain active in that tenant/site.
- If any condition fails, verification returns `sensor_source_mapping_source_not_active_or_verified` and writes no verification event. Reject/revoke decisions remain available to record governance changes.
- Existing mapping events remain immutable. The check applies to new verification decisions only.

Staging evidence required before activation:
- [ ] Verified exact-site source and explicitly global verified source both permit approval only for the matching tenant/site/asset.
- [ ] Unverified, rejected, revoked, disabled, wrong-tenant, wrong-site, inactive-site, inactive-tenant and inactive-asset sources/resources cannot receive a new verified mapping event.
- [ ] Source revocation between mapping registration and reviewer approval causes verification to fail without an event.
- [ ] Assigned independent reviewer and active tenant membership/site-grant checks remain enforced.
- [ ] Mapping revocation after prior verification remains append-only and blocks subsequent quality assessments through the latest-event resolver.

**Stop condition:** Do not enable mapping approval until PRs #231, #232 and #233 are reviewed together, their exact-head CI remains green, and the staging lifecycle cases above pass. CI is not staging E2E and this runbook does not authorize deployment or migration.

## 16. Atomic governance event transition gate

Core PR #234 is stacked on #233 and closes a concurrent-review race across sensor/source mappings, sensor calibrations and measurement-quality policies. Exact-head CI at `9bf7212115e647987769d72466098771ec96eda5`, [run 44200928478](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44200928478), passed all three jobs: API/security tests, tenant Worker tests (including disposable ordered D1 migrations and gateway/private Worker integration), and research raster tests.

Each final event INSERT now checks the latest event state at write time. Verify/reject require no prior event; revoke requires the latest event to remain verified. The same write rechecks active tenant membership, active reviewer assignment, exact record scope and submitter/reviewer independence. Mapping verification additionally checks the live verified source and active tenant/site/asset; calibration verification rechecks the exact registered certificate evidence.

A losing concurrent transition writes no event and returns a conflict. This is repository CI validation, not staging E2E. Before activation, staging must exercise two simultaneous verification requests, verify-vs-revoke races, duplicate revocations, reviewer assignment revocation during review, and tenant membership deactivation during review for each record type. Confirm exactly one valid transition wins, all losing attempts write no event, and latest-event resolvers block subsequent assessments after revocation. Historical assessments remain immutable.

**Stop condition:** PRs #231–#234 require independent review and coordinated staging lifecycle E2E. CI does not authorize deployment, migrations, or production activation.

## 17. Atomic assessment-time governance gate

Core PR #235 is stacked on #234 and closes a time-of-check/time-of-use gap between resolving current governance evidence and writing a new measurement-quality assessment. For `passed` and `failed` results, the final assessment INSERT now rechecks the exact verified observation, active tenant/site/asset, live verified source, latest verified mapping, latest valid verified calibration, and latest effective verified policy including its assessed bounds/version.

Exact-head CI at `eb519ab020fcd9eb05bf6e74df37b0845ded7603`, [run 44201439932](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44201439932), passed all three jobs: API/security, tenant Worker (ordered disposable D1 migrations and gateway/private Worker integration), and research raster tests.

If a revocation or scope change commits before the assessment write, the conditional INSERT writes no passed/failed result; the workflow records a durable `not_assessed` result with reason `governance_state_changed_before_assessment`. A revocation committed after the assessment write does not rewrite that historical assessment.

Staging tests must race assessment creation against source disable/revocation, mapping revocation, calibration revocation/expiry, policy revocation/effective-window changes, and tenant/site/asset deactivation. Confirm a valid assessment only commits if every exact gate still holds at write time. Confirm blocked attempts create `not_assessed` and preserve all historical records.

**Stop condition:** PRs #231–#235 require independent review and coordinated staging lifecycle/race E2E. CI is not staging evidence and does not authorize deployment, migration, or production activation.


## 18. Assessment idempotency and concurrent replay gate

Core PR #236 is stacked on PR #235 and binds an assessment request key to its original observation. A request key already used for a different observation returns `409 measurement_quality_idempotency_conflict`; it must not return the other observation's assessment. Same-observation retries return the original immutable assessment.

Both passed/failed conditional assessment writes and non-assessable assessment writes use the existing unique `(tenant_id, request_id)` constraint with `ON CONFLICT DO NOTHING`. A losing concurrent insert reloads the winning row and returns it only when the observation matches; a different observation conflicts. No schema migration was added.

Exact-head CI for PR #236 head `10659aebd639e8f66dfc327927d8a8e5293471f8`, run [44202004431](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44202004431), passed all three jobs: API/security, tenant Worker with ordered disposable D1 migrations and gateway/private Worker integration, and research raster. Regression tests cover same-observation replay, cross-observation key reuse and a simulated concurrent insert collision. The concurrency collision test is a controlled test fixture; it is not a live concurrent D1 race.

### Staging evidence required
- Reuse one tenant request key for a different observation; confirm 409 and no unrelated assessment disclosure.
- Retry the same request key for the same observation; confirm the original immutable assessment is returned.
- Submit truly simultaneous same-key/same-observation requests against staging D1; confirm exactly one assessment row exists and both callers receive the same winner.
- Submit same-key/different-observation requests concurrently; confirm one binding wins and the other conflicts without returning the winner's assessment.
- Repeat for passed/failed and not_assessed outcomes, including governance revocation between initial lookup and final insert.
- Confirm tenant isolation: identical request keys in different tenants do not share or expose results.

**Stop condition:** PR #236 remains draft and unmerged. Require independent review and real staging D1 concurrency tests before treating assessment idempotency as release-ready. CI is not live concurrency evidence and does not authorize deployment or production activation.


## 19. Consolidated governed ingestion and assessment candidate

Draft integration PR #237 consolidates the source-governance and assessment changes from #231–#236 on top of integration base #229. The consolidated branch head is `b433caaa156bfe3bd2c1a511bdced7ccd1bf2aaf`; its only commit above the #236 runtime-tested head `10659aebd639e8f66dfc327927d8a8e5293471f8` adds `docs/NOVA_V1_GOVERNED_INGESTION_ASSESSMENT_INTEGRATION.md`. No runtime source changed in that docs-only commit. No new workflow run was reported for the docs-only commit; the unchanged runtime tree passed #236 exact-head CI [44202004431](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44202004431), 3/3 jobs.

The consolidated PR is a review surface, not a merge. Its included runtime controls and staging checklist are described in the integration note. All constituent PRs remain draft/unmerged. Independent review, true staging D1 concurrency/revocation tests, migration rehearsal, exact secret/key reconciliation and explicit release approval remain mandatory.

**Stop condition:** Do not treat PR #237 as independently CI-validated at its docs-only head; cite the #236 runtime head and CI only for the unchanged runtime files. No staging/production changes.


## 20. Legacy Idempotency-Key assessment transport model (superseded)

Core PR #238 and NOVA OS PR #13 introduced an interim browser-held `Idempotency-Key` model. That model is superseded for the current browser workflow by the server-owned operation ledger in Core PRs #251–#253 and NOVA OS PR #62.

The current contract is:
- The gateway generates a fresh, single-use `x-nova-request-id` for every transport attempt.
- The browser POSTs the same exact tenant/observation reserve intent; Core derives the durable operation identity from the verified Access actor and scope. The browser does not create or persist an idempotency key.
- The browser claims a bounded lease and completes the operation. Core atomically inserts the assessment and terminalizes the operation.
- After a lost response or page reload, repeating reserve recovers the same operation. An actor-scoped read returns the original terminal assessment.
- A new assessment is an explicit successor naming the prior terminal operation.

Do not use the earlier component-memory retry behavior as evidence of reload recovery. See section 23 for the current implementation, exact CI evidence and outstanding staging gates. The legacy assessment route remains present until a separate cutover closes the bypass; do not enable production UI routes before that gate.



## 21. Consolidated governed ingestion and assessment HTTP candidate

Core draft PR [#239](https://github.com/wisemaiarservices-debug/nova-core/pull/239) consolidates the governed ingestion and assessment runtime chain (#231–#236) together with the HTTP operation-idempotency change (#238), on top of integration base #229. Exact documentation-inclusive head: `3fbc2d75bf904f49548db7793b88776ce01ac3f3`. Its own NOVA Core CI [run 44293452819](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44293452819) passed all three jobs: API/security tests, research raster tests, and Tenant Worker integration including ordered disposable D1 migrations, query preparation, fixture seeding and gateway/private Worker integration.

This is consolidated repository CI only. PR #239 remains draft/open/unmerged. The CI result does not prove live staging Access configuration, deployed Worker/D1 pairing, real concurrent D1 races, lost-response replay, key custody, independent security approval or production readiness.

- [ ] Independently review the full #239 diff and its stacked base/dependency chain.
- [ ] Execute the staging source-revocation, governance-transition, assessment-write and true concurrent idempotency tests.
- [ ] Exercise lost-response recovery through the deployed Access gateway and private Worker with stable operation key and fresh transport nonce.
- [ ] Reconcile deployed HMAC keys, issuer/audience values, owner assertion signer and permit JWK/key IDs across OS and Core.
- [ ] Rehearse the complete migration sequence on a disposable staging clone and verify the actual staging migration ledger.
- [ ] Record explicit independent security review and staging release authorization.

**Stop condition:** Do not merge, migrate, configure secrets, deploy or activate ingestion/assessment routes solely because PR #239 CI passed. All staging and release gates remain mandatory.


## 22. Observation insert-time source revocation guard — Core PR #239

Core PR [#239](https://github.com/wisemaiarservices-debug/nova-core/pull/239) includes migration `0035_observation_ingestion_requires_verified_source.sql`. Its `BEFORE INSERT` trigger rejects observations unless the exact source remains `verified`, belongs to the same tenant and module, is global or scoped to the exact site, and both tenant and site remain active. This database write-boundary check supplements the Worker pre-insert lookup and is intended to close the source-revocation gap between lookup and persistence.

- Latest consolidated PR #239 head at this update: `9596844d540e30d97d563e726630b0a637046f17`.
- Exact-head Core CI [run 44293947333](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44293947333) passed API/security, ordered disposable D1 migration/query/fixture and gateway/private Worker integration, and research raster jobs.
- Migration tests cover unverified/disabled source rejection, exact tenant/site/module scope, global-source behavior, and inactive tenant/site rejection. The revocation sequence is modeled sequentially in SQLite tests; real concurrent staging validation remains required.
- Add migration `0035` after the previously ordered Core migrations in the staging rehearsal. Do not apply it to production or any live database from this runbook.

This is repository CI evidence only. It does not prove a deployed Worker/D1 race, authorize ingestion activation, or change the no-production-release boundary.

## 23. Assessment-operation HTTP V1 and reload-safe result recovery (Core PRs #251–#253; NOVA OS PR #62)

### Candidate implementation and exact CI evidence

- Core PR #251 adds the actor-scoped private HTTP handler and public gateway routes for reserve/recover, read, claim, renew and complete. Lease expiry is calculated from the same server timestamp used by the five-minute lease validator. Exact-head CI run 44319855156 passed all three jobs for code head `f77732ff910628d9cb6bbbbd1604489ab389bb98`.
- Core PR #252 adds a local Wrangler multi-Worker HTTP integration through the public Access gateway, private Worker Service Binding and disposable D1. It exercises reserve/recover, actor isolation, claim, renew, completion, terminal replay and explicit successor creation. The CI observation is deliberately unverified and must produce `not_assessed`; this is not evidence of a scientific pass. Exact-head CI run 44320168686 passed all three jobs for head `ad23f8e61eb41dc4a120e1f1bc7550ec3e27e705`.
- Core PR #253 extends actor-scoped operation reads to return the exact immutable assessment for completed/not_assessed operations. The result lookup binds tenant, site, observation, operation ID and verified Access actor; a missing or mismatched result fails closed. Exact-head CI run 44320629236 passed all three jobs for head `be5c98380c43ef9943e65b9290ce245ee8ccf238`.
- NOVA OS PR #62 replaces component-memory idempotency with the Core operation ledger. A reload repeats the same reserve intent and reads the stored terminal result; reassessment requires an explicit predecessor. It stores no operation ID or credential in localStorage/sessionStorage. Exact-head OS CI run 44322386574 passed tenant resource validation tests, TypeScript and production build for head `c6e1c63cb71119c2ac8ca3deaee527a1f3d70ccc`.

### Release interpretation

These are draft PRs and CI evidence only. They do not prove a deployed Worker, staging migration, live Access session, configured HMAC/JWK, real customer tenant, or production readiness. Core's legacy measurement-quality assessment route remains present; this candidate has not yet forced all new assessment writes through the operation ledger.

### Additional staging gates

1. Merge only after independent review of Core #251–#253 and NOVA OS #62, including authorization, route allowlists, request replay and migration ordering.
2. Apply the ordered migrations to a disposable staging D1 and verify the operation tables/triggers and exact assessment-to-operation binding.
3. Deploy the matching private Worker and gateway routes with approved Service Bindings, Access audience/issuer, HMAC key ring, NOVA OS pinned public JWK/key ID, CORS allowlist and OS gateway origin. Do not put secrets in repository files or browser bundles.
4. Run live staging tests for reserve retry after lost response, page reload and second-device recovery, active/expired lease recovery, terminal result read, explicit successor replay, actor isolation, membership/site-grant revocation, source/mapping/calibration/policy revocation, and concurrent reserve/claim/renew/complete races.
5. Prove no legacy route bypass can create a new assessment outside the ledger before enabling the OS workflow. Preserve historical assessment reads; do not rewrite historical results.
6. Capture exact migration versions, Worker deployment IDs, configuration fingerprints (never secret values), test request IDs, outcomes and reviewer sign-off in the release packet.

No staging or production action is authorized by these PRs. Do not provision tenants, enable ingestion, write customer data, or enable production UI routes based solely on CI success.
