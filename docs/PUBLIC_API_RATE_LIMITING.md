# Public API rate-limit namespace contract

Status: **source and account-inventory evidence only — no production activation or deployment authorization**.

## Cloudflare namespace semantics

Cloudflare Workers Rate Limiting bindings do not require a separately provisioned namespace resource. The Worker configuration declares a `ratelimits` binding with:

- a binding `name`;
- a positive-integer `namespace_id`, represented as a string; and
- a `simple` policy with a limit and a period of 10 or 60 seconds.

The account owner chooses the identifier. It must be unique within the Cloudflare account. Bindings that intentionally use the same namespace ID share counters for the same key in each Cloudflare location, including across Workers. Cloudflare's current documentation says Rate Limiting bindings are not currently visible in the dashboard; the binding is configured through Worker settings/configuration rather than created as a separate dashboard resource.

Therefore, the correct lifecycle is **select an unused account-unique positive integer in source configuration, deploy the Worker binding, and verify the deployed script binding/settings**. Do not wait for a namespace-creation API or claim that a namespace was provisioned independently.

## NOVA Core allocation record

The public API configuration declares:

| Field | Value |
|---|---|
| Worker | `nova-core-api` |
| Binding | `NOVA_PUBLIC_API_LIMITER` |
| Namespace ID | `33226001` |
| Limit | 60 |
| Period | 60 seconds |
| Source | `apps/api/wrangler.jsonc` |

The live Cloudflare account inventory on 2026-11-28 returned exactly one deployed Worker script, `nova-core-api`. Its current deployed settings expose only `NOVA_CORE_ALLOWED_ORIGINS`; no rate-limit binding is deployed yet. The source declaration therefore reserves `33226001` for the public API binding. No second deployed Worker script was present in the inventory to collide with it at the time of this check.

This is evidence for the current account inventory, not a permanent guarantee. Re-run the script inventory and inspect all Worker configurations before adding another Worker or reusing this identifier. Keep `33226001` dedicated to `NOVA_PUBLIC_API_LIMITER`; do not reuse it for a different independent limiter.

## Runtime and security semantics

- The current middleware keys by canonical `CF-Connecting-IP`, HTTP method and allowlisted API route. It rejects missing, duplicate, malformed, whitespace-padded, overlong and non-ASCII client-IP values before calling the binding.
- `X-Forwarded-For` is not trusted.
- The configured policy is an approximate per-key limit in each Cloudflare location. It is not a strict global quota; Cloudflare documents eventual background synchronization and possible bursts above the threshold.
- IP-based limits can combine unrelated users behind shared NAT/mobile egress. Treat this as anonymous abuse mitigation, not authentication or an individual-user entitlement. Revisit keying if authenticated API identities are introduced.
- A missing binding or runtime limiter failure returns a fail-closed 503. A deployment must not proceed unless the binding is present and its deployed settings are verified.
- Preview and production environments must not accidentally share a namespace if isolated counters are required. Follow Cloudflare's current Workers Preview resource-isolation guidance when adding preview bindings.

## Required deployment readbacks

Before any production dispatch:

1. Refresh the account's Worker script inventory and verify the intended namespace ID remains unique among deployed Worker configurations.
2. Confirm the exact deployment commit contains the expected `ratelimits` declaration and that the Wrangler/Pywrangler dry-run accepts it.
3. After a separately authorized deployment, read back the exact `nova-core-api` script settings and verify a `ratelimit` binding named `NOVA_PUBLIC_API_LIMITER` is present. The pre-deployment account readback currently does not contain it.
4. Run edge tests for allowed requests, threshold rejection, malformed client IP fail-closed behavior and limiter failure. Do not interpret a local Worker simulation as proof of Cloudflare's approximate distributed counters.
5. Record the deployed version ID, binding readback and test evidence without exposing secrets or user IP addresses.

## Current release decision

The earlier assumption that namespace `33226001` needed a separate Cloudflare namespace-creation API call was incorrect and is superseded by this contract. The identifier is selected in Worker configuration, and the current live script inventory has no competing deployed Worker script.

This resolves the **namespace provisioning/creation uncertainty**, but does not authorize production deployment. Production remains **HOLD** because the current deployed Worker does not yet have the binding, and the independent D1, Access, migration, observability-redaction and end-to-end acceptance gates remain incomplete.
