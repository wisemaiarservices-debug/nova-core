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


## 12. First-site and asset onboarding recovery checks

- [ ] Confirm first-site creation is atomic across site, owner read grant, grant event, site event and immutable idempotency record.
- [ ] Confirm asset registration is atomic across unconfigured asset, owner read grant, grant event, asset event and immutable idempotency record.
- [ ] Exact retry with the original key and body digest returns the original resource; changed-body reuse conflicts.
- [ ] Lost-response retry is tested only while active-owner, active-tenant, approved dual-identity and applicable site-grant checks remain satisfied.
- [ ] Owner suspension, tenant deactivation, identity-link revocation and missing site grant remain denied before replay lookup; no recovery bypass is introduced.
- [ ] Batch failure is verified not to leave or report a partial resource; append-only audit records are not deleted to repair retries.

A response lost after a site/asset commit is not a reason to create a replacement. If current authorization no longer permits replay, resolve authorization through the governed lifecycle first, then retry the exact original request. The source tests were reviewed at Core candidate #229; staging E2E evidence remains required.


## 13. Observation ingestion source lifecycle gate

- [ ] Core PR #231 reviewed and its exact-head CI passed.
- [ ] Core migration `0035_observation_ingestion_requires_verified_source.sql` applied in exact order on a disposable clone and staging only with approval.
- [ ] Ingestion Worker deployment is confirmed to use the database containing migration `0035`.
- [ ] Staging race test confirms that revocation committed after the Worker's preliminary source lookup but before observation insert causes the database insert to fail.
- [ ] Verified site-scoped source and explicitly global verified source remain accepted only for their exact module/tenant scope.
- [ ] Unverified, rejected/unverified, revoked/disabled, wrong-module, wrong-tenant, wrong-site, inactive-site and inactive-tenant sources are rejected at insert time.

**Stop condition:** Do not enable ingestion if migration `0035` is absent, its CI is incomplete, or the deployed Worker/database pairing has not passed the revocation-race test. The PR is a draft remediation candidate; this checklist does not authorize deployment.


- Exact-head CI [run 44195702163](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44195702163) passed all three jobs: API/security tests; tenant Worker tests including disposable ordered D1 migrations, SQL preparation, fixtures and gateway/private Worker integration; and research raster tests. This is automated repository validation only, not staging E2E.

## 14. Measurement-quality assessment source lifecycle gate

- [ ] Core PR #232 reviewed; exact-head CI passed at `0b6f6e64cd4382392a406ce9198cd603b5c50b15` (run `44195702163`, all three jobs successful). Confirm dependency PR #231 is also reviewed and exact-head CI passed.
- [ ] Assessment rechecks the current source record at assessment time: exact tenant, module and site/global scope; source remains `verified`; tenant and site remain active.
- [ ] Staging test verifies that a source revoked or disabled after observation verification cannot receive a new `passed` or `failed` quality assessment.
- [ ] The rejected attempt is recorded as `not_assessed` with reason `source_not_active_or_verified`.
- [ ] Historical immutable assessments remain retrievable and are clearly distinguished from newly performed assessments; exact idempotent replay does not create a new assessment.
- [ ] The existing verified mapping, effective verified calibration, exact approved policy and independent-review requirements remain enforced.

**Stop condition:** PR #232 exact-head CI is now green, but do not enable new quality assessments until the staging source-revocation assessment test and all other release gates pass. This checklist does not authorize deployment or migration.


## 9. Sensor-to-source mapping approval lifecycle

Core PR #233 is a draft child of PR #232, following PR #231. Exact-head CI passed at `bb901fe9cc4ef67ded575b2b8d34873a4085df1a`, run [44199420503](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44199420503), with all three jobs successful (API/security, tenant Worker/D1 integration, research raster).

The final mapping-event INSERT atomically rechecks that the exact source remains verified in the same tenant, is global or scoped to the exact mapping site, and that the tenant, site and mapped asset remain active. It also rechecks active tenant membership, reviewer assignment and exact mapping identity at write time. Invalid lifecycle or scope produces `sensor_source_mapping_source_not_active_or_verified` without a verification event. Reject/revoke actions remain available; immutable history is not rewritten.

- [ ] Review PR #233 together with dependencies #231 and #232.
- [ ] Verify exact-site and global-source happy paths in staging.
- [ ] Verify unverified/revoked/disabled source and inactive or mismatched tenant/site/asset cases fail without a verification event.
- [ ] Verify reviewer membership, assignment and site-grant controls remain enforced.
- [ ] Verify mapping revocation blocks subsequent quality assessment while historical assessments remain immutable.

**Release gate:** mapping approval remains disabled until independent review and staging lifecycle E2E pass. Automated CI does not authorize staging or production.

## 10. Atomic governance event transitions

Core PR #234 at exact head `9bf7212115e647987769d72466098771ec96eda5` passed [CI run 44200928478](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44200928478) with all three jobs successful (API/security, tenant Worker/D1 integration, research raster). The PR makes mapping, calibration and quality-policy review event inserts conditional on the latest event state and rechecks reviewer assignment and active tenant membership at write time. Concurrent losers write no event.

- [ ] Review PR #234 with dependencies #231–#233.
- [ ] Stage simultaneous verify/verify, verify/revoke, revoke/revoke, and reviewer/membership revocation races for mapping, calibration and policy.
- [ ] Confirm exactly one valid transition commits and losing calls return conflict without appending events.
- [ ] Confirm revocation blocks subsequent assessments and does not rewrite historical assessment records.

CI is not staging evidence. No production enablement until independent review and staging E2E pass.

## 11. Atomic assessment-time governance gate

Core PR #235 at exact head `eb519ab020fcd9eb05bf6e74df37b0845ded7603` passed [CI run 44201439932](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44201439932) with all three jobs successful (API/security, tenant Worker/D1 integration, research raster).

For passed/failed assessments, the final database write rechecks exact observation verification, active tenant/site/asset, live source, latest verified mapping, latest valid calibration, and latest effective quality policy including bounds/version. If governance changes before the write, the system records `not_assessed` with `governance_state_changed_before_assessment`, not a stale pass/fail. Historical assessments are never rewritten.

- [ ] Review PR #235 with dependencies #231–#234.
- [ ] Stage assessment-vs-source-revocation and source-disable races.
- [ ] Stage assessment-vs-mapping-revocation, calibration-revocation/expiry, and policy-revocation/effective-window races.
- [ ] Stage tenant/site/asset deactivation during assessment.
- [ ] Confirm blocked attempts are durable `not_assessed` results and historical assessment records remain immutable.

CI does not replace staging E2E. Production activation remains gated.


## 12. Assessment idempotency and concurrent replay

Core PR #236 exact head `10659aebd639e8f66dfc327927d8a8e5293471f8` passed [CI run 44202004431](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44202004431), all three jobs (API/security, tenant Worker/D1 integration, research raster).

The assessment request key is bound to its observation. Cross-observation reuse returns `409 measurement_quality_idempotency_conflict`; same-observation replay returns the original immutable assessment. Assessment inserts use the existing unique `(tenant_id, request_id)` constraint with conflict-safe writes; concurrent losers reload the winner and verify observation identity. No migration was added.

- [ ] Review PR #236 with dependencies #231–#235.
- [ ] Verify same-observation retries return the original assessment.
- [ ] Verify cross-observation key reuse returns 409 without disclosing another assessment.
- [ ] Exercise true simultaneous duplicate requests against staging D1 and confirm one durable row and consistent winner responses.
- [ ] Exercise same-key/different-observation races and confirm conflict without cross-observation disclosure.
- [ ] Repeat for passed/failed and not_assessed outcomes and verify tenant isolation.

The concurrent insert regression currently simulates the database conflict result; it is not a live concurrent D1 race. Independent review and staging concurrency E2E remain mandatory. CI does not authorize deployment or production activation.


## 13. Consolidated governed ingestion and assessment candidate

Draft PR [#237](https://github.com/wisemaiarservices-debug/nova-core/pull/237) consolidates PRs #231–#236 on top of #229. Consolidated head: `b433caaa156bfe3bd2c1a511bdced7ccd1bf2aaf`; runtime source head: `10659aebd639e8f66dfc327927d8a8e5293471f8`. The single commit above the runtime source adds only `docs/NOVA_V1_GOVERNED_INGESTION_ASSESSMENT_INTEGRATION.md`; no runtime files changed. No separate workflow run was reported for the docs-only commit. The unchanged runtime head passed [CI run 44202004431](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44202004431), all three jobs.

- [ ] Review consolidated PR #237 and all child PRs #231–#236.
- [ ] Do not interpret the #236 CI run as live staging concurrency evidence.
- [ ] Complete the real staging race/replay, migration rehearsal, independent review and configuration/key reconciliation gates before activation.

PR #237 remains draft/unmerged. No deployment or migration is authorized.


## 14. Legacy Idempotency-Key assessment transport model (superseded)

Core PR #238 and NOVA OS PR #13 introduced an interim browser-held `Idempotency-Key` model. It is superseded for the current browser workflow by the server-owned operation ledger in Core PRs #251–#253 and NOVA OS PR #62.

Current behavior:
- A fresh `x-nova-request-id` transport nonce is generated for each gateway/private Worker attempt.
- The browser repeats the same exact reserve intent; Core derives the durable operation identity from verified Access actor and tenant/site/observation scope.
- The browser claims a bounded lease and completes the operation. Assessment insert and operation terminalization are atomic.
- After lost response or page reload, reserve recovers the same operation and actor-scoped read returns the original terminal assessment.
- Reassessment requires an explicit successor operation naming the previous terminal operation.

The older browser-memory key is not the current recovery mechanism. Refer to section 17 for current Core/OS PR heads, exact CI evidence and outstanding release gates. The legacy assessment route remains present and must not bypass the operation ledger at activation.


## 15. Consolidated governed ingestion and assessment HTTP candidate

- [ ] Review Core draft PR [#239](https://github.com/wisemaiarservices-debug/nova-core/pull/239), which consolidates governed ingestion/assessment PRs #231–#236 and HTTP operation-idempotency PR #238 on integration base #229.
- [ ] Verify exact documentation-inclusive head `3fbc2d75bf904f49548db7793b88776ce01ac3f3` and exact-head Core CI [run 44293452819](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44293452819). All three jobs passed: API/security, research raster, and Tenant Worker integration including ordered disposable D1 migrations, query preparation, isolated fixture seeding and gateway/private Worker integration.
- [ ] Confirm independent review covers the full consolidated diff and all prerequisite PRs.
- [ ] Complete true staging D1 source/governance revocation races and concurrent same-key/different-observation replay tests.
- [ ] Complete deployed Access gateway/private Worker lost-response replay with stable operation key and fresh transport nonce.
- [ ] Reconcile deployed secrets, HMAC key ring, issuer/audience, owner assertion signer, permit JWK and key IDs without recording secret values.
- [ ] Verify the actual migration ledger and rollback/recovery rehearsal on isolated staging.
- [ ] Record independent security approval and explicit staging release authorization.

**Release gate:** PR #239 remains draft/unmerged. Passing repository CI is not live staging evidence and does not authorize migration, deployment, customer onboarding or production activation.


## 16. Governed ingestion and assessment candidate — Core PR #239

- [ ] Record Core PR #239 exact reviewed/deployed SHA. Latest fetched candidate head: `9596844d540e30d97d563e726630b0a637046f17` (re-fetch before staging).
- [ ] Verify exact-head Core CI [run 44293947333](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44293947333): API/security, ordered disposable D1 migration/query/fixture plus gateway/private Worker integration, and research raster tests.
- [ ] Include migration `0035_observation_ingestion_requires_verified_source.sql` after its prerequisites; verify the trigger rejects unverified/disabled/mismatched sources and inactive tenant/site state.
- [ ] Exercise a real two-session source-revocation race between ingestion lookup and observation insert against staging D1; confirm no observation is written when revocation wins.
- [ ] Validate assessment source lifecycle, atomic mapping/calibration/policy transitions, final assessment evidence gates, and same-key idempotent replay using actual concurrent D1 requests.
- [ ] Through the deployed Access gateway, test a committed assessment with a lost response: retry with the same operation `Idempotency-Key` and a fresh transport nonce; confirm one immutable assessment and the original result.
- [ ] Record OS PR #13 exact SHA and verify browser retry behavior; note that a full page reload loses the component-memory operation key and is not reload-safe.

PR #239 and all constituent changes remain draft/unmerged. CI is not deployed staging evidence, and this packet authorizes no migration, secret configuration, ingestion activation, tenant provisioning, deployment or production operation.

## 17. Assessment-operation HTTP V1 and reload-safe recovery

### Candidate PRs and exact-head CI

| Component | PR / exact head | CI evidence | State |
|---|---|---|---|
| Core private/public operation routes | [Core #251](https://github.com/wisemaiarservices-debug/nova-core/pull/251), `f77732ff910628d9cb6bbbbd1604489ab389bb98` | Run 44319855156 — 3/3 jobs passed | Draft / unmerged |
| Local Worker + D1 operation workflow | [Core #252](https://github.com/wisemaiarservices-debug/nova-core/pull/252), `ad23f8e61eb41dc4a120e1f1bc7550ec3e27e705` | Run 44320168686 — 3/3 jobs passed | Draft / unmerged |
| Terminal result in actor-scoped reads | [Core #253](https://github.com/wisemaiarservices-debug/nova-core/pull/253), `be5c98380c43ef9943e65b9290ce245ee8ccf238` | Run 44320629236 — 3/3 jobs passed | Draft / unmerged |
| Browser reload recovery | [NOVA OS #62](https://github.com/wisemaiarservices-debug/NovaOS/pull/62), `c6e1c63cb71119c2ac8ca3deaee527a1f3d70ccc` | Run 44322386574 — validation, TypeScript and production build passed | Draft / unmerged |

### Evidence demonstrated in CI

- Full local Worker HTTP route flow through Access gateway, Service Binding and disposable D1.
- Actor-scoped operation access, five-minute lease fencing, claim/renew, durable `not_assessed` completion for an unverified fixture, completion replay and explicit successor.
- Terminal operation read returns the exact actor/scope-bound immutable assessment.
- Browser workflow reserves/recover operations from server-derived scope, reads terminal result after reload, and does not persist operation IDs or credentials in browser storage.

### Outstanding release evidence
- [ ] All four PRs merged after review; matching Core base and migrations approved.
- [ ] Staging D1 migrations applied and verified in order.
- [ ] Private Worker/gateway deployments and Service Bindings verified.
- [ ] HMAC secret and key ring, Access issuer/audience, pinned OS public JWK/key ID and exact CORS origins verified without exposing secret values.
- [ ] Live staging reload/second-device/lost-response tests completed.
- [ ] Live staging actor, membership/grant revocation and source/mapping/calibration/policy revocation races completed.
- [x] Local concurrent D1 route races validated in Core PR #255 / CI 44324522544: one claim winner, one lease-renew winner, and one immutable terminal assessment/event under concurrent completion.
- [ ] Repeat concurrent operation and revocation races against the actual staging D1/Worker deployment; local CI does not replace staging validation.
- [ ] Merge Core PR #254 with dependencies #251–#253 and NOVA OS #62 after review; verify the retired direct assessment POST returns `410 assessment_operation_required` in staging and no new assessment row is written through that route.
- [ ] Independent security review and operator sign-off recorded.

The CI fixture intentionally uses an unverified observation and validates `not_assessed`; it does not establish scientific correctness or a passed assessment. No staging/production deployment, tenant provisioning, customer data operation or paid service is included in these PRs.

## 18. Legacy direct assessment writer retirement (Core PR #254)

- [ ] Review Core PR [#254](https://github.com/wisemaiarservices-debug/nova-core/pull/254), which returns `410 assessment_operation_required` from the legacy direct assessment POST after signed identity, active membership and exact site-read-grant checks.
- [ ] Verify exact-head CI [44323728348](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44323728348) passed all three jobs for `6bd6543af4c511970b0dd111af9eef9e8ffdbda5`, including the gateway/private Worker/D1 legacy-route rejection and continued operation-ledger workflow.
- [ ] Merge only with Core #251–#253 and NOVA OS #62 after independent review.
- [ ] In staging, verify the old route returns 410 and creates no assessment row.
- [ ] Verify all browser assessment writes use reserve/recover, claim and complete; terminal reads recover the original immutable result.
- [ ] Preserve historical assessment reads and audit history.

PR #254 remains draft/unmerged. CI proves the candidate code path only; no staging/production action has been initiated.

## 19. Concurrent assessment-operation HTTP route evidence (Core PR #255)

- [x] Local concurrent claim race: exactly one winner.
- [x] Local concurrent lease-renew race: exactly one winner for the expected lease fence.
- [x] Local concurrent completion: both callers recover the same immutable `not_assessed` result and only one terminal event is recorded.
- [x] Exact-head CI [44324522544](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44324522544) passed all three jobs for `1f40fa0a16cff21f46f1cbe8712635279a48f0d9`.
- [ ] Repeat these races against staging D1 and verify behavior under live membership/site-grant and source/governance revocation.
- [ ] Capture staging deployment IDs, migration versions, request IDs and operator sign-off.

The CI observation is intentionally unverified; it validates concurrency and durable `not_assessed` handling, not scientific correctness. PR #255 remains draft/unmerged.

## 20. Assessment-operation authorization revocation (Core PR #256)

- [x] Local D1 integration creates an operation for an invited member with an exact site read grant, revokes the grant, and verifies subsequent operation read and claim return 404.
- [x] Exact-head CI [44325916622](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44325916622) passed all three jobs for `189764f113dfe4e4ba0283508bd5759f95e00ccb`.
- [ ] Repeat against staging D1/Worker and test membership suspension/revocation plus site-grant revocation during in-flight completion.
- [ ] Confirm audit records and no result leakage after authorization revocation.

Local CI confirms the candidate route behavior only; PR #256 remains draft/unmerged.

## 21. Final assessment-write authorization recheck (Core PR #257)

- [x] Local D1 test reserves and claims while authorized, revokes the exact site read grant, then verifies completion returns 404 without inserting an assessment.
- [x] Exact-head CI [44326401282](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44326401282) passed all three jobs for `fd9dca89f55b0030fef90b9621256730c5818df1`.
- [ ] Repeat in staging for site-grant and membership revocation, tenant/site deactivation, and source/mapping/calibration/policy revocation between claim and completion.
- [ ] Verify no assessment row or terminal event is written after authorization failure, and confirm audit consistency.

PR #257 remains draft/unmerged; local CI is not staging approval.

## 22. Membership lifecycle recheck at final assessment write (Core PR #258)

- [x] Local D1 HTTP test: invited member reserves and claims an operation, owner suspends membership, completion is denied, and membership is reactivated for later test cases.
- [x] Exact-head CI [44329522954](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44329522954) passed all three jobs for `78743db97a7787582eedfae77147ffb63b2f496e`.
- [ ] Repeat in staging for membership suspension and permanent revocation while reserved and while a lease is active.
- [ ] Verify denial produces no assessment row or terminal event and preserves audit consistency.
- [ ] Confirm recovery after legitimate membership reactivation follows the approved operation state/lease rules.

Local CI is not staging approval; PR #258 remains draft/unmerged.

## 23. Tenant lifecycle recheck at assessment completion (Core PR #259)

- [x] Local D1 HTTP test: member claims operation, current tenant owner suspends tenant, completion is denied, owner reactivates tenant for later scenarios.
- [x] Exact-head CI [44334952958](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44334952958) passed all three jobs for `e79d14a060608a0277e42593a75a317668220b1f`.
- [ ] Repeat in staging for tenant suspension and archival while operations are reserved and while leases are active.
- [ ] Verify no assessment row or terminal event is written after tenant authorization denial.
- [ ] Verify reactivation does not revive an expired lease or bypass normal claim/recovery rules.
- [ ] Verify lifecycle event history remains consistent and tenant-isolated.

Local CI is not staging approval; PR #259 remains draft/unmerged.

## 24. Source lifecycle revocation at assessment completion (Core PR #260)

- [x] Source lifecycle result handling accepts a positive D1 changed-row count when the source-status trigger also runs.
- [x] Unit regression test covers D1 reporting two changed rows for one lifecycle event plus trigger side effect.
- [x] Local D1 HTTP test: reserve and claim an assessment operation, revoke the verified source through the independent reviewer route, then complete as `not_assessed` / `source_not_active_or_verified`.
- [x] Exact-head CI [44347311546](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44347311546) passed all three jobs for `5dc2875a3d7b8e0bcd4cf5de5985a6134729fd7b`.
- [ ] Repeat in staging for source revocation after reservation and after lease claim.
- [ ] Verify no passed/failed assessment is written and source lifecycle history remains append-only.
- [ ] Verify ingestion and subsequent assessment attempts fail closed after revocation.

Local CI is not staging approval; PR #260 remains draft/unmerged.


## 25. Calibration and quality-policy revocation

- [x] Local gateway → private Worker → disposable D1 revokes calibration and approved quality policy through independent reviewer routes while assessment leases are active.
- [x] Outcomes are durable `not_assessed` with `verified_calibration_missing_or_expired` and `approved_quality_policy_missing` respectively.
- [x] Exact-head CI [44351221152](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44351221152) passed all three jobs.
- [ ] Repeat both revocations in staging; verify append-only history and no passed/failed result after revocation.

## 26. Expired lease recovery and stale-worker fencing

- [x] Local HTTP test waits for natural lease expiry, recovers with a new lease version/token, and rejects stale completion with 409.
- [x] Exact-head CI [44384405921](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44384405921) passed all three jobs.
- [ ] Repeat with staging D1 and verify one recovery winner, stale worker rejection, and authorization revocation during expiry.
- [ ] Keep production lease duration at its normal bounded default; CI-only shortened lease override must never enter production configuration.

## 27. Sensor/source-mapping revocation

- [x] Local HTTP integration revokes the exact verified mapping while a successor assessment operation is leased.
- [x] Completion becomes `not_assessed` / `verified_sensor_mapping_missing`.
- [x] Exact-head CI [44384936706](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44384936706) passed all three jobs.
- [ ] Repeat in staging for mapping revocation after reservation and after lease claim; verify exact tenant/site/asset/sensor scope and immutable history.

## 28. Site lifecycle and inactive-site assessment interlock

- [x] Migration 0040 creates a separate append-only lifecycle event ledger and one-to-one event-consumption ledger; direct status-update bypass is rejected.
- [x] Only active ↔ inactive transitions are supported; archived/unconfigured states remain non-transitionable.
- [x] Local gateway → private Worker → disposable D1 verifies owner/admin authorization, exact site grant, event replay, changed-intent conflict, event history and explicit reactivation.
- [x] Migration 0041 permits only fixed `not_assessed` / `site_inactive_at_completion` when deactivation wins; passed/failed still require active site.
- [x] Both assessment/deactivation race orders and expired-lease recovery after deactivation pass.
- [x] Latest Core #266 exact-head CI [44398811437](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44398811437) passed all three jobs, including ordered disposable D1 migrations and full HTTP integration.
- [ ] Repeat all authorization, replay, direct SQL bypass and both race-order cases in approved staging.
- [ ] Verify reactivation does not restore child resource, source, grant, calibration, mapping or policy state.
- [ ] Capture migration version, Worker deployment IDs, request IDs, audit evidence and operator sign-off before any production change.

All local CI evidence is pre-staging validation only. Core PR #266 and consolidated NOVA OS PR #64 (including #63) remain draft/unmerged; no staging or production migration/deployment has been performed.


## 29. Site lifecycle migration and rollback approval record

### Migration evidence

- [ ] Confirm the staging migration ledger is contiguous through 0039 before applying 0040 and 0041.
- [ ] Record the exact schema migration ledger and non-secret schema fingerprint before and after migration.
- [ ] Confirm 0040 creates the lifecycle event/application ledgers and all authorization, transition, application and append-only triggers.
- [ ] Confirm 0041 replaces the assessment-operation binding guard and preserves the fixed inactive-site not_assessed outcome.
- [ ] Record disposable-clone rehearsal evidence and the approved database backup/snapshot reference.
- [ ] Record the exact Core private Worker and gateway deployment IDs, Service Binding configuration fingerprint, Access issuer/audience identifiers, HMAC key version identifiers and CORS origin set. Never record secret values.
- [ ] Record NOVA OS deployment ID and the exact gateway origin only after the Core routes are verified.

### Rollout approval

- [ ] Independent security reviewer approved the Core migration, authorization triggers, exact route allowlists, HMAC envelope and browser contract.
- [ ] Staging operator explicitly approved migration and deployment.
- [ ] Authenticated read-only site detail and event-history checks passed before mutation controls are enabled.
- [ ] Both site-deactivation/assessment-completion race orders passed in staging.
- [ ] Owner/admin, non-admin, inactive membership, revoked site grant, cross-tenant and idempotent replay cases passed.
- [ ] Reactivation was verified not to restore child assets, sources, grants, calibrations, mappings or policies.
- [ ] NOVA OS mutation controls were enabled only after the matching Core runtime passed the above gates.

### Rollback decision record

- [ ] Confirm whether any lifecycle event has been written. If none, an application rollback may leave migrations 0040/0041 in place under the approved procedure.
- [ ] If any lifecycle event exists, do not roll back to code that lacks lifecycle history/actions or inactive-site assessment completion. Preserve the matching Core runtime and audit records; use a reviewed forward fix.
- [ ] Do not drop lifecycle tables/triggers, delete or rewrite lifecycle events/applications, reverse 0041, or change site status with direct SQL.
- [ ] Any database restore requires explicit database-owner approval and a documented data-loss assessment; it is a disaster-recovery action, not routine rollback.

Production release remains separately gated. This packet does not authorize production migration, deployment, tenant/site provisioning or customer-data operations.


## 30. Cross-repository review handoff — consolidated candidates (2026-11-18)

**Core candidate:** PR #266, head `e157555927f85a30a04366c4317a32b00b0fa42c`, stacked on #265 and containing #239/#229 ancestry. Core #266 exact-head CI [44398811437](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44398811437) passed all three jobs.

**NOVA OS candidate:** PR #64, head `21b43f1f7c38e29bf92414fbc1d02a620f4b8893`, stacked on OS #63 and 56 commits ahead of OS #13 with zero commits behind. OS exact-head CI [44401357217](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44401357217) passed 65 tests, TypeScript and production build.

**Reviewer handoff:** Core documentation PR #267 contains the exact implementation surfaces, ancestry, adversarial review checklist and evidence limitations. It is documentation-only. Its exact head `8eda207252251bdd24f19fb5d12ceee37053bb17` passed [CI 44415107568](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44415107568), all three jobs.

- [ ] Independent reviewer confirms exact Core/OS SHAs, ancestry and all migration files 0035–0041.
- [ ] Review identity/tenant isolation, exact route allowlists, HMAC envelope, idempotency, actor-bound operation recovery and lease fencing.
- [ ] Review source, mapping, calibration, policy and site lifecycle revocation behavior at final database write boundaries.
- [ ] Independently rerun disposable D1/Worker integration and adversarial concurrency tests.
- [ ] Verify legacy assessment writer is disabled with HTTP 410 `assessment_operation_required` and no alternate assessment writer bypasses the operation ledger.
- [ ] Verify OS browser workflow against Core APIs, including reload, second-device, lost responses and explicit successors.
- [ ] Keep site lifecycle action reload recovery separate: it remains component-memory-only; operator must reload exact site status/history after an uncertain action.
- [ ] Complete secret/key custody, Access, D1 binding, monitoring, retention/data-rights, backup and forward-recovery review.
- [ ] Record exact reviewed SHAs, test commands, findings, remediation commits, reviewer identity and written pass/fail decision.

**Decision:** PENDING INDEPENDENT REVIEW. CI success and implementation-author review are not independent sign-off. This packet does not authorize staging, production deployment, migrations, tenant/site provisioning or customer-data operations.


## 31. Assessment-operation browser integration and recovery gate

- [x] OS #64 uses Core's server-backed operation IDs and reserve/read/claim/renew/complete workflow; it does not rely on a browser-generated assessment idempotency key as the durable operation identity.
- [x] OS client tests cover reservation, claim, completion, terminal replay after reload, expired-lease recovery, stale-completion conflict and authorization denial without fallback.
- [ ] Independent reviewer verifies exact browser/API route matching, actor-bound recovery and second-device behavior.
- [ ] In isolated staging, simulate lost reserve, claim and completion responses; reload and recover the same operation; confirm stale lease completion is rejected.
- [ ] Verify explicit successor behavior and that no successor is silently created after an uncertain operation.
- [ ] Confirm site deactivation during an active operation yields only `not_assessed` / `site_inactive_at_completion`.
- [ ] Keep Site Lifecycle mutation recovery separate: after a full reload, inspect current site status and append-only event history before another action.

**Decision remains PENDING.** No staging or production authorization is implied.


## 32. Latest OS #64 exact-head CI gate

- [x] OS PR #64 head `df5fb4ecaabb5b6580f6ab7d3e97b22b90476213` passed exact-head run 44399707616: 57 tests passed, TypeScript check and production build passed.
- [x] Prior code head `b76ef56906025b5c9d1c68a8fd66bde7fd680d47` passed run 44399619773.
- [x] Core #266 exact head `e157555927f85a30a04366c4317a32b00b0fa42c` passed run 44398811437.
- [ ] Independent reviewer validates browser/API interaction and second-device/reload scenarios.


## 33. Consolidated OS candidate sign-off

- [x] Superseded standalone OS PR #62 is closed without merge; its useful operation recovery work is incorporated into OS #64.- [x] OS #64 latest exact head `21b43f1f7c38e29bf92414fbc1d02a620f4b8893` passed CI run 44401357217: 65 tests, TypeScript and production build.
- [x] Core #266 exact head `e157555927f85a30a04366c4317a32b00b0fa42c` passed CI run 44398811437.
- [ ] Independent reviewer verifies the complete Core #266 + OS #63/#64 stack.
- [ ] Isolated staging browser test: lost reserve/claim/complete response, reload, second device, explicit successor, site deactivation and stale lease.
- [ ] Confirm separate Site Lifecycle reload/manual-recovery behavior; do not treat assessment operation recovery as site-lifecycle recovery.


## 34. Durable site lifecycle command recovery — review status

**Candidate stack (all draft/unmerged):**
- Core #269–#274: durable site lifecycle command ledger, attributed resolver, immutable retry key, private service and signed gateway routes.
- Core #274 exact head `bee2cfa56f0327dc8518bc9056f98e8d48aea471`; exact CI [44534356078](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44534356078) passed 3/3, including the complete disposable-D1 gateway/private-Worker HTTP integration.
- NOVA OS #66 exact head `af8df15b091095f262215f357402f69bdeecf0b8`; exact CI [44534466001](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44534466001) passed tenant-resource tests, TypeScript and production build.

**Implemented and CI-validated:**
- [x] Prepare/replay, read, apply, reject and collection recovery after full reload.
- [x] Original-actor-only apply; no cross-admin takeover.
- [x] Separate resolver attribution; rejection does not mutate site status.
- [x] Database verifies `original_actor_revoked` and `site_status_changed` against actual membership/grant/site state; generic or mismatched reasons are denied.
- [x] Browser requires exact-site status/history review before resume or resolution.
- [x] Resolver can recover its terminal decision after reload from its own append-only command event.

**Still mandatory before any release:**
- [ ] Independent security reviewer signs off on Core migrations 0042–0045, trigger conditions, route/HMAC/Access identity binding, actor fencing and recovery semantics.
- [ ] Independent reviewer reruns the complete HTTP/D1 integration and concurrency/replay cases.
- [ ] Explicitly authorized isolated staging browser E2E covers lost prepare/apply/reject responses, full reload, second device, original actor revocation, stale site state and resolver attribution.
- [ ] Coordinated Core/OS dependency cutover and legacy-route retention/removal plan is reviewed; no route is removed by these PRs.
- [ ] Record exact SHAs, test evidence, reviewer identity, findings/remediation and explicit release decision.

**Decision: PENDING INDEPENDENT REVIEW AND AUTHORIZED STAGING.** These PRs are not merged or deployed. This packet does not authorize staging or production migrations, deployments, tenant/site provisioning or customer-data operations.


## 35. NOVA OS #66 site-lifecycle Chromium validation — exact head 2026-11-19

**Automated evidence**
- OS PR #66 exact head: `f6f3fac6eeef77194975b6b462b499413c36fe1c`.
- Exact-head CI [44561011857](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44561011857) passed both jobs: `site-lifecycle-browser` (real Chromium) and `web-build` (tenant resource tests, TypeScript and production build).
- Browser scenarios: lost prepare response followed by reload recovery and original-actor apply; pending command after an apply transport failure; stale-site resolver rejection with no site-status mutation and no lifecycle application.
- Browser test uses a simulated gateway and synthetic tenant/site values. It is not live Core staging, production Access authentication, independent security review or customer-data validation.
- Dependency vulnerability inventory is diagnostic/non-blocking and is not a security audit.

**Release gates remain open**
- [ ] Independent reviewer validates Core #269–#274 migrations 0042–0045, trigger semantics, HMAC/Access actor binding, route allowlists and command recovery.
- [ ] Independent reviewer reruns Core disposable-D1 integration and OS browser tests against exact recorded SHAs.
- [ ] Explicitly authorized isolated staging E2E covers lost prepare/apply/reject responses, full reload, second device, original-actor revocation, stale site state and resolver attribution.
- [ ] Record reviewer identity, exact SHAs, findings/remediation and written pass/fail.

**Decision: PENDING INDEPENDENT REVIEW AND AUTHORIZED STAGING.** OS #66 remains draft/unmerged. This CI result does not authorize merge, staging or production deployment, migrations, tenant/site provisioning or customer-data operations.


## 36. Exact Core/OS command-recovery candidate matrix (2026-11-19)

The following SHAs and exact-head workflow conclusions were re-fetched from the corresponding open draft PRs. These are repository CI results only.

| PR | Scope | Exact head | Exact-head CI |
|---|---|---|---|
| Core #269 | Durable command ledger | `024c416fcd1b3eafeb4972ae4da221a8825ab162` | [44419113035](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44419113035), success |
| Core #270 | Parallel API-contract docs | `5f5ff725fee5f6102831aa2aba784305100d5789` | [44423114799](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44423114799), success |
| Core #271 | Resolver safeguards | `4b8408a2588d2983d1d26c59d4e850a189436b8e` | [44429015759](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44429015759), success |
| Core #272 | Durable retry keys | `03258be130caa4692bc419a60a1eeaa7bf5c81ec` | [44435163843](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44435163843), success |
| Core #273 | Command service | `77f9e5d8192c5070246f6b25468c6421a1270ff6` | [44528863233](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44528863233), success |
| Core #274 | Private Worker + signed gateway | `bee2cfa56f0327dc8518bc9056f98e8d48aea471` | [44534356078](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44534356078), success |
| NOVA OS #66 | Durable lifecycle browser workflow | `f6f3fac6eeef77194975b6b462b499413c36fe1c` | [44561011857](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44561011857), success |
| Core #267 | This documentation handoff | `21487321ee762c25285ff65448dbab4976fe2781` | [44561864602](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44561864602), success |
| NOVA OS #67 | Original-actor revocation Chromium scenario (test-only) | `71669c2481496d24f4f3a61e0c0ab2103c6dd25e` | [44566307214](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44566307214), success |
| Core #275 | Original-actor revocation through signed gateway/private Worker/disposable D1 (test-only) | `a7381fb32554198ac7d0726503cc97dcc0320e8d` | [44567289774](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44567289774), success |

Core #270 is a parallel documentation branch, not a runtime dependency in the #271–#274 chain. Core #274 is the integrated runtime candidate; OS #66 is its draft browser client. Every listed PR remains open/draft/unmerged. The OS browser gateway uses synthetic identifiers and a simulated gateway; no live staging or production Access validation is claimed.

**Reviewer requirements:** independently fetch and inspect each exact SHA; verify branch ancestry and migration order 0042–0045; rerun the integrated Core disposable-D1 HTTP suite and OS Chromium/build jobs; record commands, findings, severity, remediation SHAs and explicit pass/fail. Green CI is not independent security approval.

**Decision: PENDING INDEPENDENT REVIEW AND EXPLICIT STAGING AUTHORIZATION.** No migration, deployment, tenant/site provisioning or customer-data operation is authorized by this packet.