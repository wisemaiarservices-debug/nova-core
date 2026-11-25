# Public API rate limiting

The public research/demo API applies two Cloudflare Worker Rate Limiting bindings
to /api/v1/* requests:

- PUBLIC_API_RATE_LIMITER: 120 requests per 60 seconds per client address.
- UPSTREAM_API_RATE_LIMITER: an additional 12 requests per 60 seconds for
  WaPOR, PVGIS, and NASA POWER provider-proxy routes.

Both bindings use CF-Connecting-IP, which Cloudflare supplies at the edge.
The implementation deliberately ignores X-Forwarded-For and other caller
identity headers. Missing, malformed, or duplicate edge client-address headers,
missing bindings, and binding errors fail closed with HTTP 503. Exceeded buckets
return HTTP 429. CORS preflight and /health are not charged.

## Important limits

Cloudflare Worker Rate Limiting is approximate and local to each Cloudflare
location. It is not a strict global quota, an upstream provider quota guarantee,
or a DDoS mitigation product. Requests can temporarily exceed a configured
threshold while counters synchronize. A shared public IP (office, carrier NAT,
or privacy relay) shares one bucket and may affect multiple legitimate users.
The current thresholds are initial abuse-control defaults, not customer SLAs;
review them against observed traffic before increasing or tightening them.

The application is public and does not currently issue API keys or authenticate
anonymous callers. IP-based buckets are therefore a pragmatic anonymous-client
identifier, not a durable user identity. Add authenticated per-account keys if
the product later introduces API credentials. Strict global quotas or hard
upstream spend limits require a coordinated durable limiter and provider-side
controls, not this binding alone.

## Preview isolation

Production bindings use distinct, deterministic account-specific namespace IDs.
Cloudflare Preview configuration does not currently list Rate Limiting bindings
among its Preview-specific supported binding categories. Therefore this PR
deliberately does not configure a Preview limiter: the middleware returns 503
for /api/v1 requests in a Preview where those bindings are absent, while
/health remains available. Do not add a Preview namespace unless the current
Wrangler Preview schema and runtime support it. The namespace IDs are not secrets.

## Deployment gate

The binding declarations in wrangler.jsonc are source configuration. They do
not update an already deployed Worker until its next successful deployment.
Before production release, validate the exact production configuration and
binding availability, then verify 429 and 503 behavior against a controlled
production smoke test. Do not enable provider traffic on a deployment where
the bindings are absent.
