const encoder = new TextEncoder();
const MAX_TOKEN_LENGTH = 16_384;
const MAX_JWKS_BYTES = 65_536;
const MAX_JWKS_KEYS = 32;
const CLOCK_SKEW_SECONDS = 60;

function decodePart(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_supabase_token");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  try { return Uint8Array.from(atob(padded), c => c.charCodeAt(0)); }
  catch { throw new Error("invalid_supabase_token"); }
}
function decodeJson(value) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodePart(value))); }
  catch { throw new Error("invalid_supabase_token"); }
}
function issuerConfig(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid_supabase_issuer_configuration"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith("/auth/v1") || url.pathname.includes("//"))
    throw new Error("invalid_supabase_issuer_configuration");
  return url.origin + url.pathname;
}
async function boundedText(response) {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_JWKS_BYTES))
    throw new Error("supabase_jwks_invalid");
  if (!response.body) throw new Error("supabase_jwks_invalid");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JWKS_BYTES) { await reader.cancel(); throw new Error("supabase_jwks_invalid"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("supabase_jwks_invalid"); }
}
function signingKey(key, kid) {
  if (!key || key.kid !== kid || key.kty !== "RSA" ||
      typeof key.n !== "string" || typeof key.e !== "string" ||
      (key.use !== undefined && key.use !== "sig") ||
      (key.alg !== undefined && key.alg !== "RS256") ||
      (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify")))) return false;
  try {
    const modulus = decodePart(key.n), exponent = decodePart(key.e);
    return modulus.length >= 256 && modulus[0] >= 0x80 &&
      exponent.length === 3 && exponent[0] === 1 && exponent[1] === 0 && exponent[2] === 1;
  } catch { return false; }
}

/**
 * Verify a Supabase Auth access token using the configured project's asymmetric
 * RS256 JWKS. Legacy shared-secret (HS256) tokens are intentionally rejected.
 * The caller must not use returned claims until this function resolves.
 */
export async function verifySupabaseAccessToken(token, config, nowSeconds = Math.floor(Date.now() / 1000), fetcher = fetch) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH)
    throw new Error("missing_or_oversized_supabase_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_supabase_token");
  const header = decodeJson(parts[0]);
  if (!header || Array.isArray(header) || header.alg !== "RS256" ||
      typeof header.kid !== "string" || !header.kid || header.kid.length > 256 ||
      header.crit !== undefined || header.b64 === false || header.jku !== undefined || header.x5u !== undefined)
    throw new Error("unsupported_supabase_token_algorithm");

  const issuer = issuerConfig(config?.issuer);
  const audience = config?.audience;
  if (typeof audience !== "string" || !audience.trim() || audience.length > 256)
    throw new Error("invalid_supabase_audience_configuration");

  let response;
  try {
    response = await fetcher(issuer + "/.well-known/jwks.json", {
      method: "GET", redirect: "error", headers: { Accept: "application/json" },
    });
  } catch { throw new Error("supabase_jwks_unavailable"); }
  if (!response.ok) throw new Error("supabase_jwks_unavailable");
  let jwks;
  try { jwks = JSON.parse(await boundedText(response)); }
  catch (cause) {
    if (cause?.message === "supabase_jwks_invalid") throw cause;
    throw new Error("supabase_jwks_invalid");
  }
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0 || jwks.keys.length > MAX_JWKS_KEYS)
    throw new Error("supabase_jwks_invalid");
  const keyIds = new Set();
  for (const key of jwks.keys) {
    if (!key || typeof key.kid !== "string" || !key.kid || key.kid.length > 256 || keyIds.has(key.kid))
      throw new Error("supabase_jwks_invalid");
    keyIds.add(key.kid);
  }
  const jwk = jwks.keys.find(key => signingKey(key, header.kid));
  if (!jwk) throw new Error("supabase_signing_key_not_found");

  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodePart(parts[2]), encoder.encode(parts[0] + "." + parts[1]));
  } catch { valid = false; }
  if (!valid) throw new Error("supabase_signature_invalid");

  const claims = decodeJson(parts[1]);
  if (!claims || Array.isArray(claims) || typeof claims !== "object" || claims.iss !== issuer)
    throw new Error("unexpected_supabase_issuer");
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (!Array.isArray(audiences) || !audiences.includes(audience))
    throw new Error("unexpected_supabase_audience");
  if (typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 200)
    throw new Error("invalid_supabase_subject");
  if (claims.role !== "authenticated") throw new Error("supabase_authenticated_role_required");
  if (!Number.isInteger(claims.exp) || claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS)
    throw new Error("supabase_token_expired");
  if (!Number.isInteger(claims.iat) || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS || claims.exp <= claims.iat)
    throw new Error("supabase_token_issue_time_invalid");
  if (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) ||
      claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS || claims.nbf >= claims.exp))
    throw new Error("supabase_token_not_yet_valid");
  return Object.freeze({ issuer, subject: claims.sub, audience, issuedAt: claims.iat, expiresAt: claims.exp });
}
