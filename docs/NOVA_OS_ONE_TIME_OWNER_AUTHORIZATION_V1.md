# NOVA Core integration: one-time NOVA OS owner authorization V1

**Status:** proposed protocol; documentation only. No runtime implementation, schema migration, secret, production configuration or deployment is included.

## Current limitation

Core currently verifies a short-lived RS256 NOVA OS owner assertion before provisioning. That proves the owner was active when NOVA OS issued the assertion; it does not provide immediate revocation. If NOVA OS membership is revoked during the assertion's five-minute lifetime, Core can still provision a tenant. NOVA OS correctly rejects the later mapping, leaving an unlinked Core tenant.

The existing Core preflight claim validator, owner-assertion UUID JTI contract, durable idempotency binding and signed mapping receipt remain necessary, but do not close this race.

## Required new-provisioning sequence

1. Verify Cloudflare Access identity and Supabase identity independently, as Core already does.
2. Verify the NOVA OS owner assertion against the pinned issuer, audience and public JWK. Bind its exact tenant, Supabase issuer/subject and UUID JTI.
3. Compute the canonical request digest in Core. Do not trust a caller-provided digest.
4. Before any new tenant, membership, grant or provisioning-request writes, call the private NOVA OS one-time authorization-consumption endpoint.
5. Authenticate Core server-to-server with an explicitly provisioned, narrowly scoped and rotatable service identity. Never expose this credential to the browser and do not reuse the Supabase service-role key as a shared bearer secret.
6. Verify the returned signed authorization permit using a separately pinned NOVA OS public key/configuration. Bind permit issuer, audience, expiry, permit JTI, assertion JTI, NOVA OS tenant, actor, Supabase identity, Access identity, idempotency key, canonical digest and stable Core correlation ID.
7. In one Core database batch/transaction, create the tenant, owner membership, grants, provisioning record and audit outcome. Persist the permit JTI and all bound claims. A missing or mismatched permit must fail before writes.
8. Issue the existing Core-signed mapping receipt only after successful provisioning. The receipt JTI remains the durable Core provisioning request ID (opaque text); the NOVA OS owner assertion JTI remains a UUID.

## Authorization ordering

NOVA OS must serialize authorization consumption against owner membership lifecycle writes by locking the same tenant row first and then the owner-membership row. The successful consumption transaction is the authorization linearization point:

- If suspension/revocation commits first, Core's authorization exchange fails and Core creates no tenant.
- If consumption commits first, that exact provisioning attempt has been authorized and may complete despite a later revocation. This deterministic race winner must be documented; a cross-database transaction is not claimed.
- Mapping still rechecks active owner status. If revocation occurs after Core commit but before mapping, the Core tenant remains unlinked and requires governed recovery.

## Retry contract

- If authorization was consumed but Core did not commit, retry the same assertion JTI, actor, tenant, idempotency key, digest, identities and correlation ID. NOVA OS must recheck current owner state before returning the same durable authorization outcome. If the owner is inactive, reject.
- If Core already committed but the browser lost the response, Core must resolve the exact existing durable provisioning record before requesting another permit. Return/re-sign a receipt for the same Core tenant and receipt JTI. Do not create another tenant and do not require a fresh authorization exchange to recover an already-committed outcome.
- Any changed actor, tenant, assertion JTI, idempotency key, digest, Access identity, Supabase identity or correlation ID is a conflict.

## Core changes required

- Extend the durable provisioning request schema and insert path to persist permit JTI, permit issuer/key identity and all claims needed to verify retry equivalence.
- Refactor the provisioning handler to resolve an existing matching committed request before the new-provisioning authorization exchange.
- For a new request, consume and verify the permit before calling the tenant-creation transaction.
- Make the tenant/membership/grant/provisioning/audit writes atomic and preserve the existing one-tenant idempotency invariant.
- Keep all missing-key, missing-endpoint, timeout, malformed-permit and claim-mismatch paths fail-closed before any new tenant write.
- Define safe behavior for an ambiguous timeout after NOVA OS consumed the authorization but before Core received the permit: exact retry only, never a changed request.

## Required tests

1. Missing/unavailable authorization endpoint prevents all new Core writes.
2. Invalid, expired, wrong-key, wrong-issuer, wrong-audience, wrong-tenant, wrong-actor, wrong-identity, wrong-digest, wrong-correlation or wrong-assertion-JTI permit prevents writes.
3. Owner suspension/revocation before consumption prevents Core tenant creation.
4. Concurrent consume and membership revocation is serialized by NOVA OS tenant/member locks.
5. Duplicate identical consume and Core requests converge to one authorization and one Core tenant.
6. Reuse of assertion JTI or idempotency key with changed claims fails closed.
7. Crash after consume but before Core commit can retry only with identical claims and active owner.
8. Crash after Core commit but before browser response returns the same tenant and receipt identity without a second authorization or tenant.
9. Revocation after Core commit but before NOVA OS mapping rejects mapping and records the unlinked state for recovery.
10. No private key, service credential or service-role key reaches browser code, logs or source control.

## Release gates

This is a coordinated NOVA OS + Core change. Do not merge or deploy either half independently. Require independent review of server-to-server authentication, ordered migrations, disposable PostgreSQL concurrency tests, Core Worker/D1 integration tests, exact issuer/audience/key pinning, end-to-end lost-response tests and an audited unlinked-tenant recovery procedure.

Until implementation and tests pass, Core provisioning remains draft-only and must not be described as immediately revocation-safe.
