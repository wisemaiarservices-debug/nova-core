# NOVA Core identity-link challenge rate limits v1

## Scope

The private tenant API enforces fixed-window limits only on dual-authenticated identity-link challenge creation and consumption. Existing tenant endpoints and owner-review decisions are unchanged.

| Operation | Per verified Supabase identity | Per verified Cloudflare identity | Window |
|---|---:|---:|---:|
| Challenge creation | 5 | 5 | 15 minutes |
| Challenge consumption | 10 | 10 | 15 minutes |

A request is accepted only if both independent identity buckets remain under the limit. The gateway and private Worker still independently authenticate Cloudflare Access; the private Worker independently verifies the Supabase JWT before incrementing either bucket.

## Storage and concurrency

- D1 stores a keyed HMAC-SHA-256 digest of the exact JSON tuple `[issuer, subject]`, using the existing private gateway HMAC secret.
- Raw issuer, subject, bearer token and challenge values are not stored in the rate-limit table.
- Both identity counters are incremented in a single D1 batch.
- The fixed-window bucket is aligned to UTC epoch 15-minute boundaries.
- Rejected attempts remain counted, but stored counts are capped at limit + 1.
- Buckets older than 24 hours are pruned on the next challenge operation.
- Over-limit requests receive HTTP 429 and a bounded `Retry-After` header.

## Operational caveats

- Limits are initial fixed defaults, not tuned from production traffic.
- Rotating the private gateway HMAC secret changes the keyed digests and effectively starts new buckets. This resets the quota window for that rotation event.
- This is application-level abuse friction, not a substitute for Cloudflare WAF/edge rate limiting, bot mitigation or monitoring.
- The fixed-window design permits a boundary burst; a sliding-window or edge-level policy may be warranted after observing real traffic.
- Production deployment requires a real D1 migration and explicit release approval. CI applies the migration only to disposable local D1.

## Validation

The Node SQLite integration tests apply migration 0025 and verify caps, separate operation buckets, fixed-window rollover, counter bounds, stale-bucket pruning, digest-only storage and invalid inputs. HTTP tests verify a rate-limited request returns 429 before challenge persistence. CI additionally applies all ordered migrations and exercises the gateway/private Worker Service Binding path against local D1.
