const encoder = new TextEncoder();
const CHALLENGE_TTL_SECONDS = 300;
const MAX_REASON_LENGTH = 1000;

function validIdentity(value) {
  return value && typeof value.issuer === "string" && value.issuer.length > 0 &&
    value.issuer.length <= 500 && typeof value.subject === "string" &&
    value.subject.length > 0 && value.subject.length <= 200 &&
    typeof value.audience === "string" && value.audience.length > 0 &&
    value.audience.length <= 256;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Persist a short-lived proof-of-control challenge after both identities have
 * already been independently verified by trusted authentication components.
 * This module never accepts or decodes raw JWTs and never stores them.
 */
export async function createIdentityLinkChallenge(db, supabaseIdentity, cloudflareIdentity,
  requestId, now = new Date()) {
  if (!validIdentity(supabaseIdentity) || !validIdentity(cloudflareIdentity) ||
      typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(requestId) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { error: "identity_link_challenge_input_invalid", status: 400 };
  }

  const challengeId = crypto.randomUUID();
  const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await sha256(challenge);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000).toISOString();

  const result = await db.prepare(
    "INSERT INTO tenant_identity_link_challenges (id, supabase_issuer, supabase_subject, cloudflare_issuer, cloudflare_subject, challenge_sha256, status, created_at, expires_at, request_id) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(request_id) DO NOTHING"
  ).bind(challengeId, supabaseIdentity.issuer, supabaseIdentity.subject,
    cloudflareIdentity.issuer, cloudflareIdentity.subject, digest, createdAt, expiresAt, requestId).run();

  if (!result?.meta || !Number.isInteger(result.meta.changes)) {
    throw new Error("identity_link_challenge_storage_invalid");
  }
  if (result.meta.changes !== 1) return { error: "identity_link_request_conflict", status: 409 };

  return { data: { challenge_id: challengeId, challenge, expires_at: expiresAt }, status: 201 };
}

/**
 * Consume a challenge only when the same independently verified identities
 * return. D1 batch keeps consume + pending request + immutable event atomic.
 */
export async function consumeIdentityLinkChallenge(db, challengeId, challenge,
  supabaseIdentity, cloudflareIdentity, requestId, now = new Date()) {
  if (typeof challengeId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(challengeId) ||
      typeof challenge !== "string" || challenge.length !== 43 ||
      !validIdentity(supabaseIdentity) || !validIdentity(cloudflareIdentity) ||
      typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(requestId) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { error: "identity_link_challenge_input_invalid", status: 400 };
  }

  const digest = await sha256(challenge);
  const matches = await db.prepare(
    "SELECT id, supabase_issuer, supabase_subject, cloudflare_issuer, cloudflare_subject, status, expires_at FROM tenant_identity_link_challenges WHERE id = ? AND challenge_sha256 = ? LIMIT 2"
  ).bind(challengeId, digest).all();
  if (!Array.isArray(matches?.results) || matches.results.length !== 1) {
    return { error: "identity_link_challenge_not_found", status: 404 };
  }
  const row = matches.results[0];
  if (row.status !== "pending" || row.supabase_issuer !== supabaseIdentity.issuer ||
      row.supabase_subject !== supabaseIdentity.subject ||
      row.cloudflare_issuer !== cloudflareIdentity.issuer ||
      row.cloudflare_subject !== cloudflareIdentity.subject ||
      typeof row.expires_at !== "string" || row.expires_at <= now.toISOString()) {
    return { error: "identity_link_challenge_invalid_or_expired", status: 409 };
  }

  const consumedAt = now.toISOString();
  const linkRequestId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const consume = db.prepare(
    "UPDATE tenant_identity_link_challenges SET status = 'consumed', consumed_at = ? WHERE id = ? AND challenge_sha256 = ? AND status = 'pending' AND expires_at > ?"
  ).bind(consumedAt, challengeId, digest, consumedAt);
  const insertRequest = db.prepare(
    "INSERT INTO tenant_identity_link_requests (id, challenge_id, supabase_issuer, supabase_subject, cloudflare_issuer, cloudflare_subject, request_id) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1"
  ).bind(linkRequestId, challengeId, supabaseIdentity.issuer, supabaseIdentity.subject,
    cloudflareIdentity.issuer, cloudflareIdentity.subject, requestId);
  const insertEvent = db.prepare(
    "INSERT INTO tenant_identity_link_events (id, link_request_id, event_type, previous_status, new_status, tenant_id, actor_cloudflare_issuer, actor_cloudflare_subject, reason, request_id) SELECT ?, ?, 'requested', NULL, 'pending', NULL, ?, ?, 'independently verified identities presented', ? WHERE changes() = 1"
  ).bind(eventId, linkRequestId, cloudflareIdentity.issuer, cloudflareIdentity.subject,
    requestId + "-requested");
  const results = await db.batch([consume, insertRequest, insertEvent]);
  if (!Array.isArray(results) || results.length !== 3 ||
      results.some(result => !result?.meta || !Number.isInteger(result.meta.changes))) {
    throw new Error("identity_link_challenge_batch_invalid");
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1 ||
      results[2].meta.changes !== 1) {
    return { error: "identity_link_challenge_conflict", status: 409 };
  }
  return { data: { link_request_id: linkRequestId, status: "pending" }, status: 201 };
}
