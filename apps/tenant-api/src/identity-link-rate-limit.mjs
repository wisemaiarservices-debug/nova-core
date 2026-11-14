const WINDOW_SECONDS = 15 * 60;
const RETENTION_SECONDS = 24 * 60 * 60;
const LIMITS = Object.freeze({ challenge_create: 5, challenge_consume: 10 });

async function identityDigest(identity, secret) {
  if (!identity || typeof identity.issuer !== "string" || typeof identity.subject !== "string" ||
      !identity.issuer.trim() || !identity.subject.trim()) throw new Error("invalid_rate_limit_identity");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new TextEncoder().encode(JSON.stringify([identity.issuer, identity.subject]));
  const digest = await crypto.subtle.sign("HMAC", key, bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Atomically increments a fixed-window bucket for each independently verified
 * identity. Only keyed digests are stored. A request is allowed only when both
 * the Supabase and Cloudflare identity buckets remain within the operation cap.
 */
export async function consumeIdentityLinkRateLimit(db, identities, operation, now = new Date(), secret) {
  const limit = LIMITS[operation];
  if (typeof secret !== "string" || secret.length < 32) throw new Error("rate_limit_secret_not_configured");
  if (!limit || !Array.isArray(identities) || identities.length !== 2) {
    throw new Error("invalid_rate_limit_input");
  }
  const timestamp = now instanceof Date ? Math.floor(now.getTime() / 1000) : Number(now);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("invalid_rate_limit_time");
  const windowStartedAt = Math.floor(timestamp / WINDOW_SECONDS) * WINDOW_SECONDS;
  const digests = await Promise.all(identities.map(identity => identityDigest(identity, secret)));
  if (digests[0] === digests[1]) throw new Error("rate_limit_identities_must_be_distinct");

  const statements = [
    db.prepare("DELETE FROM tenant_identity_link_rate_limits WHERE window_started_at < ?")
      .bind(timestamp - RETENTION_SECONDS),
    ...digests.map(digest => db.prepare(`
      INSERT INTO tenant_identity_link_rate_limits
        (identity_digest, operation, window_started_at, request_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(identity_digest, operation, window_started_at)
      DO UPDATE SET request_count = MIN(request_count + 1, ?)
      RETURNING request_count
    `).bind(digest, operation, windowStartedAt, limit + 1)),
  ];
  const results = await db.batch(statements);
  const counts = results.slice(1).map(result => {
    const row = result?.results?.[0];
    const count = row?.request_count;
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("rate_limit_result_invalid");
    return count;
  });
  const allowed = counts.every(count => count <= limit);
  return Object.freeze({
    allowed,
    limit,
    windowSeconds: WINDOW_SECONDS,
    retryAfterSeconds: WINDOW_SECONDS - (timestamp - windowStartedAt),
  });
}
