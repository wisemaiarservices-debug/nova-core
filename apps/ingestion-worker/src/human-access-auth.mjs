const encoder = new TextEncoder();
const jwksCache = new Map();
const JWKS_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 16_384;
function decodeBase64Url(segment) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("malformed_access_token");
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try { const binary = atob(padded); return Uint8Array.from(binary, c => c.charCodeAt(0)); }
  catch { throw new Error("malformed_access_token"); }
}
function decodeJsonSegment(segment) {
  try { return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment))); }
  catch { throw new Error("malformed_access_token"); }
}
function configuredIssuer(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("invalid_access_issuer"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/")) throw new Error("invalid_access_issuer");
  return parsed.origin;
}
async function fetchJwks(issuer, forceRefresh = false) {
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  let response;
  try { response = await fetch(issuer + "/cdn-cgi/access/certs", {
    headers: { Accept: "application/json" }, cf: { cacheTtl: 300, cacheEverything: true },
  }); } catch { throw new Error("access_jwks_unavailable"); }
  if (!response.ok) throw new Error("access_jwks_unavailable");
  let document;
  try { document = await response.json(); } catch { throw new Error("access_jwks_invalid"); }
  if (!document || !Array.isArray(document.keys) || document.keys.length === 0) throw new Error("access_jwks_invalid");
  jwksCache.set(issuer, { keys: document.keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return document.keys;
}
function isSigningKey(candidate, keyId) {
  return candidate && candidate.kid === keyId && candidate.kty === "RSA" &&
    (candidate.use === undefined || candidate.use === "sig") &&
    (candidate.alg === undefined || candidate.alg === "RS256") &&
    (candidate.key_ops === undefined || (Array.isArray(candidate.key_ops) && candidate.key_ops.includes("verify")));
}
async function verifyRs256(input, signature, jwk) {
  const key = await crypto.subtle.importKey("jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, encoder.encode(input));
}
/** Verify a human Cloudflare Access JWT; service tokens are deliberately rejected. */
export async function verifyHumanAccessToken(token, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH)
    throw new Error("missing_or_oversized_access_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed_access_token");
  const header = decodeJsonSegment(parts[0]);
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid)
    throw new Error("unsupported_access_token_algorithm");
  const issuer = configuredIssuer(config?.issuer);
  const audience = config?.audience;
  if (typeof audience !== "string" || !audience.trim()) throw new Error("invalid_access_audience_configuration");
  // Fetch keys only from the configured issuer, never from an untrusted claim.
  let keys = await fetchJwks(issuer);
  let jwk = keys.find(candidate => isSigningKey(candidate, header.kid));
  if (!jwk) { keys = await fetchJwks(issuer, true); jwk = keys.find(candidate => isSigningKey(candidate, header.kid)); }
  if (!jwk) throw new Error("access_signing_key_not_found");
  let valid = false;
  try { valid = await verifyRs256(parts[0] + "." + parts[1], decodeBase64Url(parts[2]), jwk); }
  catch { valid = false; }
  if (!valid) throw new Error("access_signature_invalid");
  // Claims become trusted only after successful signature verification.
  const claims = decodeJsonSegment(parts[1]);
  if (!claims || claims.iss !== issuer) throw new Error("unexpected_access_issuer");
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (!Array.isArray(audiences) || !audiences.includes(audience)) throw new Error("unexpected_access_audience");
  if (typeof claims.sub !== "string" || !claims.sub.trim() ||
      claims.sub.length > 256 || (typeof claims.common_name === "string" && claims.common_name.trim()))
    throw new Error("human_access_identity_required");
  if (!Number.isInteger(claims.exp) || claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS)
    throw new Error("access_token_expired");
  if (!Number.isInteger(claims.iat) || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS || claims.exp <= claims.iat)
    throw new Error("access_token_issue_time_invalid");
  if (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) ||
      claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS || claims.nbf >= claims.exp))
    throw new Error("access_token_not_yet_valid");
  const email = claims.email;
  if (email !== undefined && (typeof email !== "string" || !email.trim() || email.length > 320))
    throw new Error("access_token_email_invalid");
  return Object.freeze({ subject: claims.sub, issuer, audience, email: email ?? null,
    tokenId: typeof claims.jti === "string" ? claims.jti : null });
}
