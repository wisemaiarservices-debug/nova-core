# Dual-Identity Account Recovery Threat Model

**Date:** 2026-11-20  
**Status:** Design and release-gate document only  
**Scope:** NOVA Core tenant gateway and NOVA OS identity-link lifecycle

## Executive decision

Account recovery is **not established as an implemented or remotely verified capability**. The existing dual-identity design requires an independently verified Cloudflare Access human identity and Supabase Auth identity, with a tenant-owner review before a pair is approved. Recovery must not become a weaker alternate route around that requirement.

This document defines security requirements for future implementation. It does not authorize a recovery endpoint, identity-provider configuration change, live database migration, staging exercise, or production rollout.

## Assets and security objectives

Protect:
- The binding between a human Access subject, Supabase issuer/subject, and tenant membership.
- Tenant data, site/resource grants, privileged roles, audit history, and identity-link revocation state.
- Recovery proofs, challenge digests, session material, and notification destinations.

Objectives:
- Prevent account takeover, tenant boundary crossing, privilege escalation, replay, and silent identity substitution.
- Preserve tenant-owner control and immutable evidence of approval, revocation, and recovery.
- Ensure recovery never trusts caller-supplied tenant IDs, subjects, roles, email addresses, or identity-provider claims.

## Threat actors and failure modes

Assume an attacker may:
- Control one identity provider account but not the other.
- Control an email inbox, phone number, SIM, or previously registered device.
- Steal a session, bearer token, invitation token, recovery link, or browser cookie.
- Replay, race, or tamper with recovery requests and identity-link challenges.
- Exploit help-desk pressure, stale membership, compromised tenant administrators, or a lost sole-owner account.
- Attempt cross-tenant recovery, self-approval, reviewer collusion, or recovery after membership revocation.

Operational failure cases include lost Access session, lost Supabase session, both sessions lost, compromised existing identity, departed tenant owner, and unavailable tenant owner.

## Non-negotiable invariants

1. **No single-factor rebinding.** Possession of only an Access session, Supabase session, email inbox, phone number, or invitation token cannot independently bind a replacement identity pair.
2. **Provider-native recovery first.** A lost Access or Supabase identity must be recovered through that provider's supported assurance and account-recovery process. NOVA Core must not impersonate either provider or accept an unsigned identity assertion.
3. **Independent tenant authorization.** A recovery approval must come from a different active, authorized tenant owner or a separately governed recovery authority. The requester cannot approve their own recovery.
4. **No self-service sole-owner bypass.** If no independent owner remains, stop and use a separately documented, human-verified organizational recovery procedure with dual control. Do not add a secret support override or email-only fallback.
5. **Revalidate current state at commit.** Tenant status, membership status, role, grants, reviewer authority, identity issuer/audience/signature, and existing identity links must be rechecked within the durable transaction that changes the binding.
6. **Revoke old trust.** A successful rebind must revoke the previous identity pair and affected sessions/credentials where supported, invalidate outstanding challenges and recovery tokens, and remove obsolete grants according to policy.
7. **One-time secret handling.** Generate high-entropy random recovery challenges; persist only a cryptographic digest; use a short documented expiry; enforce one-time consumption atomically; never log or return the secret after initial issuance.
8. **Auditable, notified, and rate-limited.** Record requester, approver, reason, old/new identity references (not tokens), timestamps, request IDs, outcome and revocations. Notify pre-existing trusted tenant contacts and apply rate limits, cooldowns, and alerting.
9. **No tenant authority from browser input.** Tenant ID and authority must derive from authenticated server-side context and current membership, not request JSON, URL parameters alone, cookies, or custom headers.
10. **Fail closed.** Missing provider proof, ambiguous state, unavailable JWKS, conflicting membership, audit failure, or uncertain commit outcome must not produce an active replacement binding.

## Required recovery classes

| Scenario | Minimum safe disposition |
|---|---|
| Access session lost; Supabase session remains | Recover Access identity through Cloudflare's supported process; then require independent tenant-owner approval of the verified pair |
| Supabase session lost; Access session remains | Recover Supabase identity through Supabase's supported process; then require independent tenant-owner approval |
| Both sessions lost | Provider-native recovery for both identities, then independent owner approval; if unavailable, controlled organizational recovery with dual control |
| One identity suspected compromised | Freeze or revoke the affected pair, notify trusted contacts, require fresh provider-native proof and independent approval |
| Tenant owner unavailable or sole owner lost | No automatic bypass; pause sensitive operations and use dual-control organizational recovery |
| Membership suspended, revoked, or tenant inactive | Deny recovery until ordinary governance restores eligible status; recovery must not reactivate membership |
| Reviewer or owner account compromised | Revoke reviewer authority and affected links; require an independent authorized reviewer |

## Proposed state machine

States: requested → proof_pending → owner_review_pending → approved → consumed.  
Terminal or blocking states: rejected, expired, revoked, locked.

- Transitions are durable, idempotent, and append-only audited.
- Approval is bound to the exact tenant, requester, provider issuer/subject pair, request digest, and expiry.
- Consumption is a single atomic compare-and-set. Concurrent consumers must yield one winner.
- A request cannot be edited to substitute a different identity after approval; any change requires a new request and approval.
- A retry after an ambiguous response must return the immutable result for the same idempotency key, without reapplying the rebind.

## Abuse controls and privacy

- Use per-identity, per-tenant, and network-level rate limits with escalating cooldowns; avoid account-existence or membership-enumeration responses.
- Keep recovery tokens out of URLs where feasible; if a one-time link is unavoidable, redact it from proxy, analytics, and application logs and exchange it immediately for a server-side challenge.
- Do not use knowledge-based questions, public profile data, email-only possession, or support-agent discretion as identity proof.
- Minimize personal data in audit records. Store opaque provider subjects and issuer identifiers needed for verification; do not store raw JWTs, passwords, MFA secrets, recovery codes, or raw challenges.
- Notify previously verified contacts on request, approval, rejection, consumption, and revocation. Notifications are signals, not authorization.
- Define retention, data-subject access, and deletion constraints before launch without deleting mandatory security audit evidence.

## Required adversarial acceptance tests

- Access-only and Supabase-only proof cannot complete a rebind.
- Invalid signature, wrong issuer/audience/subject, stale iat, expired token, unknown kid, unavailable JWKS, and key rotation fail closed.
- Requester cannot approve; tenant admin cannot approve if policy requires owner; suspended/revoked approver cannot approve.
- Cross-tenant, inactive-tenant, revoked-membership, and stale-grant attempts are denied.
- Challenge expiry boundary, replay, token substitution, changed payload, and concurrent consumption are covered against disposable local D1.
- Audit insertion failure rolls back the rebind and leaves no active replacement identity.
- Revocation racing with approval or consumption cannot leave both old and new pairs active.
- Lost-response retries are idempotent and cannot duplicate membership, grants, or audit events.
- Sole-owner recovery cannot bypass dual control or silently grant a new owner.
- Logs, error messages, and telemetry contain no raw token, challenge, JWT, recovery code, or sensitive identity proof.

## Release gates

Before implementation can be considered:
1. Product/security owners approve the recovery policy and identify the accountable organizational recovery authority.
2. Provider-native recovery assurance and supported session/JWKS contracts are documented for both identity providers.
3. API and schema design receives independent security review, including concurrency and compromised-reviewer analysis.
4. All adversarial cases pass exact-head CI and disposable local-D1 integration.
5. Two-tenant staging acceptance proves isolation, notification, rollback, revocation, and recovery audit behavior.
6. Independent security review signs off; live Access/Supabase settings and remote D1 state are verified separately.
7. Rollout is staged with an explicit rollback plan and no weakening of existing dual-identity checks.

**Current status:** design only. No recovery endpoint or recovery override is authorized or claimed to exist. No live provider settings, secrets, tenant data, remote D1, production deployment, or paid resources were changed.
