# NOVA Core identity-link challenge ledger — schema foundation

Migration `0022_tenant_identity_link_challenges.sql` establishes database-enforced persistence rules for a future explicit Supabase Auth ↔ Cloudflare Access identity-link ceremony.

## Stored identities

The challenge binds two independently verified issuer/subject pairs:
- Supabase Auth `(iss, sub)`, obtained only after cryptographic JWT verification against the configured Supabase issuer/JWKS.
- Cloudflare Access `(iss, sub)`, obtained only from the gateway's verified Access token envelope.

The database never stores either raw JWT, a Supabase password, or challenge plaintext. Only a SHA-256 digest of a high-entropy one-time challenge is persisted. A consumed challenge must match the exact two issuer/subject pairs before a pending link request can be inserted.

## Lifecycle controls

- Challenge state is one-way: pending → consumed or expired. Identity fields and digest are immutable; deletion is blocked.
- Each challenge can create at most one link request.
- Duplicate pending requests for the same exact identity pair are blocked.
- Link requests are immutable except for owner decisions: pending → approved/rejected, then approved → revoked.
- SQL triggers require a matching append-only event for every decision.
- Approval, rejection and revocation events require an active `tenant_owner` membership in an active tenant. Admin status alone is insufficient.
- Requester and approver identities are distinct fields and are not inferred from email or matching UUIDs.

## Deliberate non-claims

This is a schema foundation, not a working identity bridge. It adds no HTTP route, challenge generator, verifier integration, token exchange, active authorization mapping, Supabase account creation, tenant provisioning, SSO or automatic role/grant synchronization. Application code must consume challenges and write request+event rows atomically; the next implementation must recheck owner membership in the same D1 mutation, preserve tenant isolation, and make revocation immediately invalidate any future mapping.

The migration is not applied to a live database. No production secrets, identity providers, tenants, permissions or deployments are changed.
