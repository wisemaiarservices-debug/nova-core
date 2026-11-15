import { verifySupabaseAccessToken } from "./supabase-access-auth.mjs";
import { createIdentityLinkChallenge, consumeIdentityLinkChallenge } from "./identity-link-challenge-service.mjs";

function validIdentity(identity) {
  return identity !== null && typeof identity === "object" &&
    typeof identity.issuer === "string" && identity.issuer.length > 0 &&
    identity.issuer.length <= 500 && identity.issuer.trim() === identity.issuer &&
    typeof identity.subject === "string" && identity.subject.length > 0 &&
    identity.subject.length <= 200 && identity.subject.trim() === identity.subject &&
    typeof identity.audience === "string" && identity.audience.length > 0 &&
    identity.audience.length <= 256 && identity.audience.trim() === identity.audience;
}

/**
 * Build the only supported dual-identity input for a future identity-link
 * challenge route.
 *
 * cloudflareIdentity MUST come from the already-verified private gateway
 * envelope (the gateway HMAC, Access issuer/audience, timestamp and nonce
 * checks must have succeeded). This function independently verifies the
 * Supabase bearer JWT against its configured issuer/JWKS/audience.
 *
 * This helper does not authorize a tenant, create a challenge, or link users.
 */
export async function verifyIdentityLinkIdentityPair({
  supabaseToken, cloudflareIdentity, accessIssuer, accessAudience,
  supabaseIssuer, supabaseAudience, verifiedSupabaseIdentity = null,
}) {
  if (typeof supabaseToken !== "string" || supabaseToken.length < 16 ||
      supabaseToken.length > 16384 || !validIdentity(cloudflareIdentity) ||
      typeof accessIssuer !== "string" || !accessIssuer ||
      typeof accessAudience !== "string" || !accessAudience ||
      typeof supabaseIssuer !== "string" || !supabaseIssuer ||
      typeof supabaseAudience !== "string" || !supabaseAudience ||
      cloudflareIdentity.issuer !== accessIssuer ||
      cloudflareIdentity.audience !== accessAudience ||
      cloudflareIdentity.issuer === supabaseIssuer) {
    throw new Error("identity_link_dual_identity_invalid");
  }

  // The HTTP route may pass the exact claims returned by its prior verifier
  // call. Direct helper callers still trigger verification here.
  const supabaseIdentity = verifiedSupabaseIdentity ?? await verifySupabaseAccessToken(supabaseToken, {
    issuer: supabaseIssuer,
    audience: supabaseAudience,
  });
  if (!validIdentity(supabaseIdentity) ||
      supabaseIdentity.issuer !== supabaseIssuer ||
      supabaseIdentity.audience !== supabaseAudience ||
      supabaseIdentity.issuer === cloudflareIdentity.issuer) {
    throw new Error("identity_link_dual_identity_invalid");
  }

  return Object.freeze({
    supabase: Object.freeze({
      issuer: supabaseIdentity.issuer,
      subject: supabaseIdentity.subject,
      audience: supabaseIdentity.audience,
    }),
    cloudflare: Object.freeze({
      issuer: cloudflareIdentity.issuer,
      subject: cloudflareIdentity.subject,
      audience: cloudflareIdentity.audience,
    }),
  });
}


/**
 * Verify both identities before persisting a one-time challenge. The
 * Cloudflare identity must be sourced from the already-verified gateway
 * envelope; no route should call this with browser-supplied claims.
 */
export async function createVerifiedIdentityLinkChallenge(db, input) {
  const pair = await verifyIdentityLinkIdentityPair(input);
  return createIdentityLinkChallenge(db, pair.supabase, pair.cloudflare,
    input.requestId, input.now);
}

/** Re-verify the same two authorities before attempting atomic challenge consumption. */
export async function consumeVerifiedIdentityLinkChallenge(db, input) {
  const pair = await verifyIdentityLinkIdentityPair(input);
  return consumeIdentityLinkChallenge(db, input.challengeId, input.challenge,
    pair.supabase, pair.cloudflare, input.requestId, input.now);
}
