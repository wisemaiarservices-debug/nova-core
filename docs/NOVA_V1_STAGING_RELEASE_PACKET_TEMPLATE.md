# NOVA V1 coordinated staging release packet

**Purpose:** controlled evidence record for an isolated NOVA OS + NOVA Core staging rehearsal.  
**Status:** template only; no staging environment, credentials, migrations, deployment or customer data are authorized by this document.  
**Rule:** never place secret values, private keys, bearer tokens, raw assertions, customer data or unredacted logs in this packet.

## 1. Change-control record

| Field | Required entry |
|---|---|
| Staging change/ticket ID | <assigned by release owner> |
| Staging project/account identifiers | <non-production identifiers only> |
| Named staging operator | <name + role> |
| Independent reviewer | <name + role; not the operator> |
| Rollback owner | <name + role> |
| Incident contact | <approved contact route> |
| Planned window | <UTC start/end> |
| Approval status | NOT APPROVED / APPROVED FOR STAGING ONLY |
| Pilot site/data approval | NOT APPROVED / APPROVED; attach scope and data-rights record |

No approval entry may be inferred from CI success or a draft pull request.

## 2. Exact source and migration inventory

Record the exact deployed commit, not merely a branch name. Re-fetch all heads and checks immediately before the change.

| Component | Intended reviewed source | Exact deployed SHA | CI run(s) | Migration set/version | Reviewer |
|---|---|---|---|---|---|
| NOVA OS owner authorization | PR #57 | <SHA> | <links> | <ordered migration IDs> | <reviewer> |
| NOVA OS nonce + mapping | PR #60 | <SHA> | <links> | <ordered migration IDs> | <reviewer> |
| NOVA OS pre-parse nonce ordering | PR #61 | <SHA> | <links> | <ordered migration IDs> | <reviewer> |
| NOVA Core combined candidate | PR #227 | <SHA> | <links> | 0034_nova_os_owner_authorization_permit.sql + prerequisites | <reviewer> |

Required dependency order: OS #57 → OS #60 → OS #61; Core #227 includes Core provisioning #222 and protected-read #223–#226. Do not stage a child without its reviewed parents. Record any replacement/integration branch and its provenance.

## 3. Environment separation and configuration inventory

For each item record configured / verified / owner / evidence link. Record names, non-secret issuer/audience values, endpoint origins, key IDs and fingerprints only.

### NOVA OS staging
- [ ] Dedicated staging Supabase project ID and URL verified; production project excluded.
- [ ] nova-core-owner-authorization deployed from the recorded OS SHA.
- [ ] Function verify_jwt = false confirmed; Core HMAC authentication is enforced in the function.
- [ ] NOVA_CORE_OWNER_AUTH_KEYS present in server-side secret store; record key IDs only.
- [ ] NOVA_OS_PROVISIONING_AUTH_ISSUER and NOVA_OS_PROVISIONING_AUTH_AUDIENCE exact values recorded.
- [ ] NOVA_OS_PROVISIONING_AUTH_JWK is the public owner-assertion verification JWK.
- [ ] NOVA_OS_OWNER_AUTHORIZATION_PERMIT_ISSUER, ..._AUDIENCE, and ..._KEY_ID recorded.
- [ ] NOVA_OS_OWNER_AUTHORIZATION_PERMIT_PRIVATE_KEY is a dedicated staging PKCS#8 RS256 key held only in the OS secret store.
- [ ] Existing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are scoped to this staging project; service-role key is not reused as the HMAC credential.
- [ ] HMAC nonce and owner-consumption ledger migrations applied in documented order; RPC grants and forced RLS verified.

### NOVA OS browser-facing functions

Owner assertion issuer (nova-core-provisioning-owner-assertion):
- [ ] NOVA_OS_ALLOWED_ORIGINS is an exact HTTPS origin allowlist; no wildcard.
- [ ] NOVA_OS_PROVISIONING_AUTH_ISSUER and NOVA_OS_PROVISIONING_AUTH_AUDIENCE are staging-specific.
- [ ] NOVA_OS_PROVISIONING_AUTH_KEY_ID and NOVA_OS_PROVISIONING_AUTH_PRIVATE_KEY are configured server-side; private key is a dedicated staging RS256 key.
- [ ] SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY reference only the staging project.

Core receipt mapping (nova-core-tenant-mapping):
- [ ] NOVA_OS_ALLOWED_ORIGINS is an exact HTTPS origin allowlist; no wildcard.
- [ ] NOVA_CORE_MAPPING_RECEIPT_ISSUER and NOVA_CORE_MAPPING_RECEIPT_AUDIENCE match the Core receipt signer.
- [ ] NOVA_CORE_MAPPING_RECEIPT_JWK is public only and matches the Core receipt-signing key.
- [ ] SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY reference only the staging project.

The owner-assertion issuer's public key must match both Core's NOVA_OS_PROVISIONING_AUTH_JWK and the private authorization function's NOVA_OS_PROVISIONING_AUTH_JWK. The Core receipt-signing private key remains in Core secret storage; NOVA OS receives only its public JWK.

### NOVA Core staging
- [ ] Dedicated staging Worker/account and D1 database verified; production resources excluded.
- [ ] Core Worker deployed from the recorded PR #227 integration SHA.
- [ ] NOVA_OS_OWNER_AUTHORIZATION_URL is the exact staging HTTPS function URL.
- [ ] NOVA_OS_OWNER_AUTH_KEYS matches OS key IDs/secrets; NOVA_OS_OWNER_AUTH_ACTIVE_KEY_ID selects an existing key ID.
- [ ] NOVA_OS_OWNER_AUTHORIZATION_PERMIT_ISSUER and ..._AUDIENCE match OS values exactly.
- [ ] NOVA_OS_OWNER_AUTHORIZATION_PERMIT_JWK contains only the pinned public JWK; kid matches the OS signer.
- [ ] SUPABASE_AUTH_ISSUER and SUPABASE_AUTH_AUDIENCE are the exact staging Supabase JWT issuer/audience.
- [ ] NOVA_OS_PROVISIONING_AUTH_ISSUER, NOVA_OS_PROVISIONING_AUTH_AUDIENCE and NOVA_OS_PROVISIONING_AUTH_JWK verify the OS owner assertion.
- [ ] NOVA_OS_MAPPING_RECEIPT_ISSUER, NOVA_OS_MAPPING_RECEIPT_AUDIENCE, NOVA_OS_MAPPING_RECEIPT_KEY_ID and NOVA_OS_MAPPING_RECEIPT_PRIVATE_KEY are configured; private key is staging-only in Core secret storage.
- [ ] ACCESS_ISSUER and ACCESS_AUDIENCE match the staging Cloudflare Access application.
- [ ] TENANT_PROVISIONING_SUBJECTS contains only approved staging subjects.
- [ ] INTERNAL_AUTH_SECRET is configured server-side where required by the private Worker/gateway topology.
- [ ] DB points to the staging D1 binding.
- [ ] Cloudflare Access application, issuer/audience, allowed subjects and gateway origin are staging-only.
- [ ] Core provisioning allowlist contains only the approved staging tenant/test identities.
- [ ] Migration 0034_nova_os_owner_authorization_permit.sql and prerequisites applied to staging D1 in order.

### Key custody and rotation
- [ ] HMAC secret generated uniquely for staging (minimum 32 characters); same key-ID map in both server secret stores.
- [ ] Permit private key custody independently verified; only public JWK fingerprint recorded here.
- [ ] Issuer, audience, key ID, JWK thumbprint/fingerprint and rotation owner recorded.
- [ ] Rotation and emergency revocation procedures tested or rehearsed.
- [ ] Clock synchronization and 120-second HMAC timestamp acceptance verified.
- [ ] No secret material appears in browser bundles, repository files, CI artifacts, logs or this packet.

## 4. Preflight database and access controls

- [ ] Fresh disposable OS tenant and Core test tenant identities provisioned for the rehearsal.
- [ ] Migration history matches the recorded release inventory.
- [ ] OS nonce reservation commits independently before parsing/authorization; duplicate nonce rejected.
- [ ] Owner-consumption RPC is service-role-only and binds the full authorization tuple.
- [ ] Browser roles cannot directly read/write nonce, consumption, permit, mapping or immutable audit ledgers.
- [ ] Direct service-role table access is absent where only narrowly scoped RPC execution is intended.
- [ ] Mapping event is immutable and unique for the exact tenant/actor/permit tuple.
- [ ] Core final protected reads recheck active identity link, tenant, membership and exact grants.
- [ ] Baseline row counts and test database snapshots recorded for rollback/recovery.

## 5. Cross-repository end-to-end test evidence

For every row record test ID, exact SHAs, correlation/request ID, expected result, actual result, redacted audit evidence and independent reviewer. Use disposable identities only.

| Test | Expected result | Pass/fail + evidence |
|---|---|---|
| Valid first authorization and provisioning | One OS consume, one Core tenant/request, one permit-bound mapping | <record> |
| Owner revoked before consume | Consume denied; zero Core tenant/membership/grant writes | <record> |
| Revocation wins concurrent lock race | Consume denied | <record> |
| Consume wins concurrent lock race | Exact authorized request may complete once; no reactivation | <record> |
| Malformed JSON with valid HMAC | Nonce committed before parse; exact request replay rejected | <record> |
| Invalid/expired owner assertion with valid HMAC | Nonce committed before assertion validation; retry needs fresh HMAC nonce | <record> |
| Invalid HMAC / stale timestamp / oversized body | Rejected without nonce reservation | <record> |
| Wrong permit key/issuer/audience/claim | Rejected before Core writes | <record> |
| Concurrent exact retry | One durable tenant/request; losing request resolves same result | <record> |
| Changed-claim retry | Conflict; no second tenant | <record> |
| Crash after OS consume before Core commit | Only exact replay; owner/tenant state rechecked | <record> |
| Lost response after Core commit | Existing Core record/receipt identity returned; no new OS consume | <record> |
| Mapping after post-consume suspension | Exact mapping may complete; no OS tenant reactivation/access grant | <record> |
| Identity-link/membership/site-grant revocation | Subsequent protected reads denied | <record> |
| Cross-tenant identity substitution | Read/write denied | <record> |
| Browser/service-role privilege boundary | Direct ledger access denied; narrow RPC boundary only | <record> |
| Secret hygiene scan | No secret/private key leakage | <record> |

A passing CI workflow is not a substitute for these deployed staging E2E tests.

## 6. Monitoring, stop conditions and recovery

Stop the staging flow immediately if any unexpected tenant write, duplicate tenant, replay acceptance, cross-tenant access, key/issuer/audience mismatch, private-key disclosure, unexplained audit/mapping state or failed negative test occurs.

- [ ] Alerting covers authorization failures, nonce replay, permit verification failures, tenant creation and mapping failures.
- [ ] Redacted logs retain correlation IDs without credentials, assertions or sensitive payloads.
- [ ] Rollback steps for Edge Function and Worker versions rehearsed.
- [ ] Migration rollback/forward-recovery decision documented; destructive rollback is not assumed safe.
- [ ] Recovery for Core tenant created but not mapped documented and rehearsed.
- [ ] Recovery for consumed OS authorization with Core commit failure documented.
- [ ] Evidence preservation and incident escalation path confirmed.

## 7. Sign-off and release decision

| Gate | Decision | Approver | Evidence |
|---|---|---|---|
| Exact source/CI review | PENDING | <independent reviewer> | <links> |
| OS/Core configuration and key custody | PENDING | <security owner> | <redacted inventory> |
| Database privileges and migrations | PENDING | <database reviewer> | <SQL evidence> |
| E2E matrix | PENDING | <test owner + reviewer> | <results> |
| Rollback/recovery rehearsal | PENDING | <rollback owner> | <rehearsal record> |
| Pilot/data rights/privacy | PENDING | <authorized business/data owner> | <approval record> |
| Staging exit | NOT APPROVED | <release authority> | <signed packet> |

**This packet authorizes nothing by itself.** Staging execution requires explicit approval through the organization's release process. Production remains a separate decision requiring independent security sign-off, production key custody/rotation, monitoring, rollback rehearsal, pilot approval and explicit production authorization.


## 8. Follow-up Core response-boundary hardening

Record whether Core PR #228 is included in the coordinated staging candidate.

- [ ] PR #228 exact reviewed/deployed SHA recorded: `46ca757c110313270f7212dab91a933dbdb47e44` (re-fetch before staging).
- [ ] Exact-head CI [run 44189340065](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44189340065) verified successful for API, tenant Worker/D1 integration, and research raster tests.
- [ ] Streaming response reader enforces 16 KiB before unbounded buffering; oversized streams are cancelled; malformed/oversized Content-Length is rejected before body read.
- [ ] Exact 16 KiB acceptance and rejection/cancellation regression tests reviewed.
- [ ] Coordinated Core integration branch includes the reviewed PR #228 change; record final combined SHA and rerun all affected checks.
- [ ] PR #228 remains draft/unmerged until independent review and explicit staging approval.

This follow-up changes the Core private authorization HTTP response handling only. It does not replace the cross-repository staging E2E matrix, key custody review, migration checks, or release approvals.


---

## 9. Current coordinated candidate superseding earlier inventory (2026-11-17)

**Use this section as the current source-of-truth candidate inventory.** Sections 2 and 8 above preserve the earlier #227/#228 source-PR history; where they conflict with this addendum, this addendum supersedes them. Re-fetch every SHA and workflow immediately before any authorized staging activity.

### Consolidated NOVA Core candidate

- Review candidate: [NOVA Core PR #229](https://github.com/wisemaiarservices-debug/nova-core/pull/229)
- Branch: `integration/core-provisioning-protected-reads-bounded-response-v1`
- Exact head: `8063ad968f6af50874b733186385fc7493b2cbfd`
- Base: PR #226 protected-read branch head `d37e678921c73fb231a5831336f0dee51cce1275`; #226 is a prerequisite in the stack and is not included in #229's base-relative diff.
- Scope: integrated #227 provisioning + protected-read tree, plus #228's bounded streaming authorization-response reader and its regression tests. Fifteen files changed relative to #226.
- Exact-head Core CI [run 44190571076](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44190571076) completed successfully, all three jobs: API/security tests; research raster tests; Tenant Worker tests including ordered disposable D1 migrations, SQL preparation, isolated fixtures, and gateway/private Worker Service Bindings + D1 end-to-end.
- PR #229 is draft/open/unmerged. The source PRs #227 and #228 remain open/draft; they are historical source branches, not the consolidated staging SHA.
- The base prerequisite #226 and its parent protected-read stack #223–#225 must be reviewed and integrated before #229 can be treated as a complete branch against the repository's mainline. Do not bypass the base dependency or merge/deploy this draft candidate.

### Coordinated NOVA OS source branches

- [OS PR #57](https://github.com/wisemaiarservices-debug/NovaOS/pull/57), head `110116d844ed73e46ee85d3508c4bac740cd6230`, based on protocol base `561fcfb1d05ae62c2b70c6d91a9267e58da242c2`. Migration [run 43973754344](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/43973754344) and administration [run 43973754374](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/43973754374) passed.
- [OS PR #60](https://github.com/wisemaiarservices-debug/NovaOS/pull/60), head `17f6c9dc590693e53bd534849192b0daf71aa030`, based on #57 head. Migration [run 44078094385](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44078094385) and administration [run 44078094194](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44078094194) passed.
- [OS PR #61](https://github.com/wisemaiarservices-debug/NovaOS/pull/61), latest head `2b6da562cdb1df354e04d6969ca2d54b646914e3`, based on #60 head. Runtime code head `dfbc6747fa5b418dc6665962ea94ac3917d4134c` passed migration [run 44169408597](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44169408597) and administration [run 44169408610](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44169408610). Latest documentation head passed migration [run 44173340563](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44173340563) and administration [run 44173340728](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44173340728).
- Preserve the strict OS dependency chain #57 → #60 → #61. All three remain draft/open/unmerged. Review them as one coordinated protocol.

### Release interpretation

These results establish source-branch automated validation only. They do not establish independent security approval, a live OS↔Core staging handshake, deployed secret/key custody, production readiness, or permission to stage. The full staging E2E matrix, independent security review, rollback/recovery rehearsal, pilot/data-rights approval and explicit staging authorization remain outstanding. No production release is authorized.


## 10. Cross-repository authorization contract review

Static source audit completed against Core #229 head `8063ad968f6af50874b733186385fc7493b2cbfd` and OS #57/#60/#61 heads `110116d844ed73e46ee85d3508c4bac740cd6230`, `17f6c9dc590693e53bd534849192b0daf71aa030`, and `2b6da562cdb1df354e04d6969ca2d54b646914e3`.

The source-level HMAC path/canonical request, 120-second timestamp window, UUID nonce, independent pre-parse nonce reservation, owner assertion identity tuple, permit issuer/audience/key ID, public-key verification, deterministic request correlation ID and exact retry rules were found aligned. The OS consume RPC requires the exact nonce/timestamp pair to have been independently reserved and serializes authorization against tenant/owner lifecycle changes.

**This is not a live staging handshake or independent security certification.** Before staging sign-off, reviewers must still reconcile the deployed HMAC key ring and active key ID, OS owner-assertion signer/public JWK, OS permit private key/Core pinned public JWK and matching `kid`, issuer and audience. Verify the actual database migration ledger and execute the live race/replay/recovery E2E matrix recorded in the runbook.

- [ ] Redacted key-pair and issuer/audience reconciliation approved.
- [ ] Actual OS and Core migration ledgers verified on disposable staging databases.
- [ ] Live HMAC replay, malformed authenticated request, concurrent owner revocation/consume, exact expired retry and lost-response recovery tests passed.
- [ ] Protected-read denial after membership, identity-link and grant revocation verified.
- [ ] Independent security review and explicit staging authorization recorded.

No secret values may be placed in this packet. Source inspection and CI do not authorize staging or production.


## 11. Migration compatibility and recovery sign-off

**OS migration compatibility preflight:** Before applying `20261116180000_nova_core_mapping_owner_assertion_binding.sql`, run the read-only orphan check documented in section 13 of `NOVA_V1_STAGING_VALIDATION_RUNBOOK.md`. It must return zero rows. This migration backfills existing mapping events from owner-provisioning attempts and aborts if any event cannot be matched by tenant, actor and idempotency key. Do not weaken the migration or fabricate/delete audit records to make it pass.

- [ ] Restorable staging backup created and restoration independently verified.
- [ ] Provisioning and owner/membership lifecycle writes frozen for the migration window.
- [ ] Full OS migration ledger captured; migrations 20261116110000 through 20261116191000 applied in exact timestamp order on a disposable clone.
- [ ] Core migration ledger captured; migrations 0026 through 0034 applied in exact numeric order on a disposable clone.
- [ ] Existing mapping-event backfill preflight returned zero orphan rows; output retained as reviewed evidence.
- [ ] Historical mapping rows with no permit tuple remain historical only; all new mapping writes require exact consumed permit/correlation binding.
- [ ] Recovery rehearsed for consumed OS permit/Core commit failure, lost Core response, Core commit/OS mapping failure, and owner suspension after consumption.
- [ ] No manual deletion or mutation of append-only authorization, mapping, receipt or audit ledgers used during recovery.
- [ ] Forward-recovery versus restore decision and accountable release owner documented.

**Stop condition:** Any orphaned legacy mapping event, unexpected migration ledger, failed restore, permit/JWK mismatch, or ambiguous partially committed provisioning state blocks staging progression pending written review. This checklist does not authorize a staging migration or deployment.
