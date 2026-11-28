# NeoHaven domain and Cloudflare Access activation plan

**Status:** approved target architecture; not yet provisioned  
**Cost policy:** zero spend until the owner explicitly authorizes a purchase or billable resource  
**Last reviewed:** 2026-11-28

## Approved hostname architecture

| Purpose | Target hostname | Intended exposure |
|---|---|---|
| Corporate identity | `neohavenurbanlabs.com` | Public DNS/domain |
| Protected application | `app.neohavenurbanlabs.com` | Cloudflare Access protected |
| NOVA Core API | `api.neohavenurbanlabs.com` | Public API routes remain application-authenticated; private administrative routes require stronger access controls |
| Public website | `www.neohavenurbanlabs.com` | Public |

These are approved target names only. This document does not assert that the domain has been purchased, registered, transferred, or added as a Cloudflare zone.

## Zero-cost interim operation

- Keep the existing `nova-core-api` Worker and `neohaven.workers.dev` endpoint intact.
- Do not add the unregistered target hostnames to CORS allow-lists, DNS, Worker routes, or Access applications.
- Do not create a D1 database, Access application, paid subscription, or other billable resource merely to prepare for the future domain.
- Continue local/disposable-D1 tests and repository-only security work.
- Preserve verified query-string redaction and current Worker observability settings.

## Domain activation sequence

1. When funds are available and the owner explicitly authorizes the purchase, register the approved domain through the selected registrar. Confirm the final checkout price, renewal price, tax, term, and auto-renew setting before purchase.
2. Add the domain as a Cloudflare zone using the same organization-controlled account that owns the Worker.
3. Verify authoritative nameserver delegation and DNSSEC status before routing application traffic.
4. Create DNS records only for services that are actually deployed. Do not publish placeholder records.
5. Attach `app.neohavenurbanlabs.com` to the application hosting target and verify TLS before enabling user access.
6. Attach `api.neohavenurbanlabs.com` to the NOVA Core Worker only after the deployment configuration and runtime bindings are aligned and verified.
7. Add `www.neohavenurbanlabs.com` only when a public website deployment is ready.

## Cloudflare Access policy design

Access is not currently enabled in the Cloudflare account and no zone is present. The following is a design, not an active policy:

- Create a self-hosted Access application for the exact protected application hostname `app.neohavenurbanlabs.com`.
- Select an organization-controlled identity provider only after the owner confirms which provider and authorized identities should be used.
- Default to deny. Create explicit allow policies for named, approved identities or managed groups; do not use broad email-domain-only access as the sole control unless that domain is verified and its account lifecycle is governed.
- Require MFA through the selected identity provider where supported.
- Keep administrative access separate from ordinary application access.
- Set short, appropriate session lifetimes and review the application audit logs.
- Do not place the public API hostname behind a blanket interactive Access login if public product clients need it. Enforce API authentication, authorization, rate limiting, and route-specific protections in the API. Protect private administrative API routes separately.
- Validate both allowed and denied identities before considering the application protected.

No email addresses, identity provider, team domain, or user group is assumed by this plan.

## Release and safety gates

Before any production hostname cutover:

- Domain ownership and Cloudflare zone identity are verified.
- TLS is active for each hostname being used.
- Access is enabled and the application policy has been tested with both authorized and unauthorized identities.
- The production Worker has the expected `NOVA_PUBLIC_API_LIMITER` binding and the post-deploy check confirms it.
- Query-string redaction is enabled before deployment and verified again after deployment.
- Staging D1 identity, migration sequence, backup/recovery approach, and read-only aggregate inventory are established before any remote migration.
- The deployed Worker configuration, CORS origins, routes, secrets, and bindings have been reviewed together.
- A rollback path and operational owner are documented.

A green local test or CI run is not evidence that a remote staging or production resource is configured correctly.

## Current account facts and non-actions

At the latest read-only account check on 2026-11-28:

- No Cloudflare zones were returned.
- The account exposed the existing `nova-core-api` Worker.
- Cloudflare Access returned `access.api.error.not_enabled`.
- Worker query-string redaction was enabled.
- Worker observability and invocation logs were enabled.

No domain was purchased, no Access application or policy was created, no DNS records were added, no D1 database was created, and no production deployment or migration was performed as part of this plan.
