# Private tenant activation checklist

Status: **readiness procedure only — not authorization to activate production**.

This checklist is the release record for the private tenant API, Cloudflare Access gateway, D1 replay protection and scheduled nonce cleanup. Complete each gate in order and attach non-secret evidence to the deployment record. A skipped, inferred, or unverified item is a failed gate. Do not place credentials, JWTs, HMAC material, personal data, or tenant records in evidence.

## 0. Change control and rollback readiness

- [ ] Identify the exact Worker names, account, target environment, Git commit and Wrangler version.
- [ ] Confirm the intended tenant hostname, private API Service Binding target, D1 database name and cleanup cron schedule.
- [ ] Confirm no paid plan, paid add-on, or unapproved usage increase is required. Stop if activation requires one.
- [ ] Record the currently deployed Worker versions and configuration snapshots for every affected Worker.
- [ ] Confirm an operator can disable gateway ingress and restore the previous Worker versions/configuration without deleting D1 data.
- [ ] Confirm no production activation is scheduled while any later gate is incomplete.

**Pass evidence:** a dated change record with resource identifiers, immutable commit SHAs, prior version IDs, rollback owner/operator, and a verified rollback path. Never record secret values.

## 1. Account and resource preflight

- [ ] Verify the target Cloudflare account and environment explicitly; do not infer from a preview deployment.
- [ ] Verify the account supports Workers, D1, Service Bindings, Workers observability settings, and Cloudflare Access for the intended hostname.
- [ ] Verify the private API Worker can be deployed with `workers_dev: false` and has no public route.
- [ ] Verify the gateway is the only public ingress and its hostname is protected by the intended Access application and policy.
- [ ] Verify resource names and IDs are unique and refer to this environment. Do not reuse placeholder UUIDs or assume a namespace ID is valid because it appears in source.
- [ ] If any required product is disabled or unavailable, stop; do not enable paid services or improvise an alternate trust boundary.

**Pass evidence:** read-only account inventory and configuration readbacks for all required resources. A preview URL, successful CI run, or Wrangler declaration is not account provisioning evidence.

## 2. D1 creation, migration and integrity

- [ ] Create the intended D1 database only after confirming environment, ownership, and rollback plan.
- [ ] Replace every placeholder D1 database ID in the private API and cleanup Worker configs with the same verified database ID.
- [ ] Enumerate the checked-in migration files in repository order; review their SQL and migration history before applying.
- [ ] Apply migrations first to an isolated non-production database and capture migration results.
- [ ] Verify required tenant, membership, grant, resource and nonce structures; unique constraints, foreign keys/triggers, indexes and nonce expiry/retention behavior against the actual migration SQL.
- [ ] Verify the private API and cleanup Worker point to the same intended database and no other environment.
- [ ] Run repository D1 integration tests against the migrated isolated database, including concurrent duplicate nonce consumption: exactly one request may consume a given nonce.
- [ ] Confirm retention cleanup removes only expired nonce rows and does not remove active replay-protection records.

**Pass evidence:** database identifier, migration list and successful migration output, schema/constraint inspection, and integration-test results. Do not apply migrations to production until isolated verification passes and a production backup/restore strategy is documented.

**Migration execution and recovery controls (Cloudflare D1):**

- Wrangler applies numbered migrations in order and records applied migration names in the D1 migration-history table. Review the exact pending list against the immutable commit before applying; use the database name, not only a mutable binding alias, to reduce wrong-target risk.
- D1 migration execution captures a backup after the apply operation. Cloudflare documents that if an individual migration fails, that migration is rolled back while earlier successful migrations remain applied. Treat the migration sequence as a series of separately committed steps, not one all-or-nothing release.
- Before any remote apply, verify that the target database supports D1 Time Travel and record a usable pre-change recovery point/time. Time Travel is automatic; the documented recovery window is plan-dependent (7 days on Workers Free and 30 days on Workers Paid). Do not upgrade a plan to obtain a longer window.
- A Time Travel restore overwrites the database in place and cancels in-flight queries. It can discard writes made after the selected recovery point. Treat restore as an incident/change-controlled operation: stop or isolate traffic, identify the exact recovery point, preserve sanitized evidence, confirm data-loss scope, restore, then verify schema, migration history and application behavior before reopening traffic.
- A failed migration rollback is not a substitute for a tested recovery plan, and a successful SQL apply is not proof that the private API and cleanup Worker use the same database or that replay behavior is correct.

**Additional pass evidence:** exact Wrangler version and target database identity; pre-apply migration list; documented recovery-window eligibility and pre-change recovery point; per-migration apply output; post-apply migration list; schema/index/constraint checks; and a tested isolated restore procedure. Never perform a destructive Time Travel restore against production as part of routine validation.

## 3. Runtime identity and secret provisioning

- [ ] Set gateway-only `NOVA_ACCESS_TEAM_DOMAIN` and `NOVA_ACCESS_AUDIENCE` to the exact Access team and application values.
- [ ] Set matching `NOVA_INTERNAL_KEY_ID`, `NOVA_INTERNAL_ISSUER`, and `NOVA_INTERNAL_AUDIENCE` on gateway and private API.
- [ ] Provision `NOVA_INTERNAL_HMAC_KEY` as a secret binding on both Workers using the same high-entropy key bytes and key ID; minimum 32 UTF-8 bytes.
- [ ] Never store secret values in source, Wrangler plain-text vars, CI logs, deployment notes, fixtures, or chat.
- [ ] Verify secret presence and configuration shape without printing or retrieving secret values.
- [ ] Document key ownership, rotation window, revocation procedure and recovery contact.
- [ ] If rotating, deploy the verifier accepting new active plus old previous key first; switch signer second; wait longer than assertion lifetime plus clock skew; remove the old key last.

**Pass evidence:** redacted configuration-presence checks, matching key IDs and issuer/audience values, and a recorded rotation/revocation procedure. Secret equality must be established through controlled secret-management procedures, never by exposing values in logs.

## 4. Cloudflare Access policy

- [ ] Create the Access application for the gateway hostname only.
- [ ] Configure a deny-by-default policy that permits only the explicitly approved user/group identities.
- [ ] Confirm the application AUD tag and team issuer exactly match gateway runtime configuration.
- [ ] Confirm the Access JWT contains a stable subject and is signed by the expected team key set.
- [ ] Verify invalid signature, wrong issuer, wrong audience, missing subject, expired token and not-yet-valid token are rejected.
- [ ] Confirm the private API hostname has no Access-bypassing public route and is not directly reachable from the internet.

**Pass evidence:** redacted Access application/policy export and edge tests for allowed and denied identities. Do not treat an Access application existing without a restrictive policy as complete.

## 5. Deploy private API and cleanup Worker

- [ ] Deploy the private API only after D1 migrations, bindings, runtime variables and secret checks pass.
- [ ] Confirm deployed private API has `workers_dev: false`, no public route, the correct D1 binding and no gateway/public-origin exposure.
- [ ] Confirm the API rejects missing, malformed, wrong-key, wrong-issuer, wrong-audience, expired, wrong-method and wrong-path internal assertions.
- [ ] Confirm nonce consumption occurs atomically before authorization/data return and duplicate/replayed assertions are denied.
- [ ] Deploy the nonce cleanup Worker against the same verified D1 database only after validating its cron schedule and bounded deletion behavior.
- [ ] Confirm cleanup runs are observable and failures alert without exposing nonce or tenant data.

**Pass evidence:** deployed version IDs, settings/binding readbacks, private endpoint non-reachability test, local/edge security test results, and one verified cleanup execution. A successful deployment alone is insufficient.

## 6. Deploy gateway and bind private API

- [ ] Deploy the gateway only after the private API is healthy and the Access policy is enforced.
- [ ] Verify the `TENANT_API` Service Binding resolves to the exact private API Worker.
- [ ] Confirm gateway has no public `workers.dev` endpoint and no unintended route.
- [ ] Verify gateway accepts only GET and the allowlisted canonical tenant-resource path; rejects query strings, fragments, other methods and malformed paths.
- [ ] Verify the gateway derives identity only from a cryptographically verified Access JWT, signs a short-lived assertion bound to exact method/path, and forwards only through the fixed Service Binding.
- [ ] Verify upstream timeout, response content-type checks, duplicate JSON member rejection, and the 1 MiB response bound.
- [ ] Verify no request body, query string, arbitrary destination, or client-supplied identity header is forwarded.

**Pass evidence:** deployed gateway version, Service Binding readback, route/hostname readback, and edge test outputs for all checks above.

## 7. Observability and privacy settings

- [ ] For each deployed Worker, set `observability.redact_query_string: true` through the supported Cloudflare Workers Script Settings API.
- [ ] Read back the setting from each exact deployed script and record the returned boolean.
- [ ] Confirm logs/traces configuration is appropriate and invocation logging/sampling does not expose credentials, assertions, tenant data or personal data.
- [ ] Confirm no secrets or sensitive identifiers are emitted by success or error paths.
- [ ] Re-check redaction after every deployment; the pinned Wrangler schema does not accept the previously attempted `redactQueryString` config field.

**Pass evidence:** per-Worker settings API readback showing redaction enabled, plus a controlled log inspection using synthetic non-sensitive query values. A config-file declaration is not evidence.

## 8. Rate limiting and public API boundary

- [ ] Verify the production rate-limit namespace was allocated through a documented, supported path and is unique in the account.
- [ ] Do not assume namespace ID `33226001` is valid or unique without authoritative allocation evidence.
- [ ] Verify the actual deployed Worker has the intended limiter binding and thresholds; source configuration and preview behavior are not production evidence.
- [ ] Verify exactly one canonical `CF-Connecting-IP` is required; malformed, duplicate, whitespace, oversized or non-ASCII values fail closed before limiter invocation.
- [ ] Verify `X-Forwarded-For` is not trusted as client identity.
- [ ] Verify thresholds are understood as per-IP/per-method/per-route buckets, not a global aggregate quota; account for shared NAT collateral effects.
- [ ] If namespace allocation cannot be verified, leave the public rate-limit activation gate open and do not deploy a binding that can cause fail-closed 503s.

**Pass evidence:** namespace allocation record, deployed binding readback, and edge tests showing expected throttling and fail-closed behavior.

## 9. Required end-to-end edge acceptance

Run with synthetic test tenants and non-sensitive data. Record status, expected outcome, timestamp, environment and deployed version; never record bearer tokens or signed assertions.

- [ ] Approved identity + authorized tenant/resource read succeeds.
- [ ] Unauthenticated request is denied at Access/gateway.
- [ ] Wrong issuer, wrong audience, invalid signature, expired and not-yet-valid Access JWTs are denied.
- [ ] Invalid, tampered, expired, wrong-key, wrong-method and wrong-path internal assertions are denied.
- [ ] Replaying the same assertion/JTI concurrently yields exactly one successful nonce consumption; all duplicates are denied.
- [ ] Cross-tenant membership/grant/resource access is denied without disclosing resource existence.
- [ ] Inactive/suspended tenant or membership is denied.
- [ ] Missing D1 binding, D1 error, malformed D1 result and missing Service Binding fail closed with generic errors.
- [ ] Oversized, malformed UTF-8, wrong content-type, duplicate-member and non-object upstream JSON responses are rejected.
- [ ] Private API cannot be reached directly through a public route.
- [ ] Query strings are not accepted/forwarded and platform redaction is confirmed in settings readback.
- [ ] Rate-limit behavior matches the documented bucket model; malformed client IP fails closed before downstream work.
- [ ] Cleanup removes expired nonce records only and leaves unexpired records intact.

**Pass evidence:** complete test matrix with every case marked PASS and linked to non-secret logs/results. Any skipped case is a release blocker.

## 10. Rollback triggers and sequence

Trigger rollback immediately for any unauthorized read, cross-tenant data exposure, replay accepted more than once, unexpected public reachability of the private API, missing/incorrect Access enforcement, secret mismatch/leak, D1 integrity failure, unbounded upstream response, or inability to confirm query-string redaction.

1. Disable or restrict gateway ingress first (Access policy deny/disable route) to stop new traffic.
2. Disable the gateway Worker or restore its previously recorded version if ingress restriction is insufficient.
3. Remove/disable the gateway Service Binding and public hostname route as required to isolate the private API.
4. Restore the last known-good Worker versions and non-secret configuration snapshots; verify the private API remains non-public.
5. Revoke/rotate compromised or uncertain HMAC keys on both Workers using the documented overlap procedure; invalidate outstanding assertions by waiting out their maximum lifetime or revoking the relevant key.
6. Preserve D1 data and migration history for investigation. Do not drop the database or reverse destructive migrations during incident response.
7. Pause the cleanup schedule only if its behavior or migration state is implicated; otherwise retain bounded replay-record retention.
8. Verify Access denial, no public private-API path, no new gateway traffic, and stable Worker health. Capture sanitized evidence and open an incident record before attempting reactivation.

**Rollback pass evidence:** ingress blocked, prior versions/config restored or isolated, private API unreachable publicly, secrets rotated if needed, D1 preserved, and sanitized verification results.

## 11. Final release decision

Production remains **HOLD** until all sections 0–10 are complete, all required evidence is recorded, no gate is skipped, and a final exact-head source/CI review is complete. This document does not itself authorize deployment, resource creation, migration, or traffic enablement.

Record the final decision as one of:
- **HOLD** — one or more gates incomplete, failed, or unverified.
- **READY FOR CONTROLLED ACTIVATION** — all gates pass; activation may proceed through the approved change window with rollback ready.
- **ROLLED BACK** — a trigger occurred and rollback verification is complete.

Never mark a gate complete based only on source code, a passing offline test, a preview deployment, or an assumed Cloudflare capability.
