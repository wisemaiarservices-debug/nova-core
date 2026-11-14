const encoder = new TextEncoder();
const jwksCache = new Map();
const JWKS_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_JWKS_BYTES = 65_536;
const MAX_JWKS_KEYS = 32;
const MAX_KID_LENGTH = 256;

function decodeBase64Url(segment) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("malformed_supabase_token");
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try { const binary = atob(padded); return Uint8Array.from(binary, c => c.charCodeAt(0)); }
  catch { throw new Error("malformed_supabase_token"); }
}
function decodeJsonSegment(segment) {
  try { return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment))); }
  catch { throw new Error("malformed_supabase_token"); }
}
function configuredIssuer(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("invalid_supabase_auth_issuer"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== "/auth/v1") throw new Error("invalid_supabase_auth_issuer");
  return parsed.origin + parsed.pathname;
}
async function readBoundedBody(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_JWKS_BYTES))
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
      if (total > MAX_JWKS_BYTES) {
        await reader.cancel();
        throw new Error("supabase_jwks_invalid");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("supabase_jwks_invalid"); }
}
async function fetchJwks(issuer, forceRefresh = false, fetcher = fetch) {
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  let response;
  try {
    response = await fetcher(issuer + "/.well-known/jwks.json", {
      method: "GET", redirect: "error", headers: { Accept: "application/json" },
    });
  } catch { throw new Error("supabase_jwks_unavailable"); }
  if (!response.ok) throw new Error("supabase_jwks_unavailable");
  let document;
  try { document = JSON.parse(await readBoundedBody(response)); }
  catch (error) {
    if (error?.message === "supabase_jwks_invalid") throw error;
    throw new Error("supabase_jwks_invalid");
  }
  if (!document || !Array.isArray(document.keys) || document.keys.length === 0 ||
      document.keys.length > MAX_JWKS_KEYS) throw new Error("supabase_jwks_invalid");
  const kids = new Set();
  for (const key of document.keys) {
    if (!key || typeof key.kid !== "string" || !key.kid || key.kid.length > MAX_KID_LENGTH || kids.has(key.kid))
      throw new Error("supabase_jwks_invalid");
    kids.add(key.kid);
  }
  jwksCache.set(issuer, { keys: document.keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return document.keys;
}
function signingKey(candidate, header) {
  if (!candidate || candidate.kid !== header.kid ||
      (candidate.use !== undefined && candidate.use !== "sig") ||
      (candidate.key_ops !== undefined && (!Array.isArray(candidate.key_ops) || !candidate.key_ops.includes("verify"))))
    return false;
  if (header.alg === "ES256") {
    return candidate.kty === "EC" && candidate.crv === "P-256" &&
      typeof candidate.x === "string" && typeof candidate.y === "string" &&
      (candidate.alg === undefined || candidate.alg === "ES256");
  }
  if (header.alg === "RS256") {
    if (candidate.kty !== "RSA" || typeof candidate.n !== "string" || typeof candidate.e !== "string" ||
        (candidate.alg !== undefined && candidate.alg !== "RS256")) return false;
    try {
      const modulus = decodeBase64Url(candidate.n);
      const exponent = decodeBase64Url(candidate.e);
      return modulus.length >= 256 && modulus[0] >= 0x80 &&
        exponent.length === 3 && exponent[0] === 1 && exponent[1] === 0 && exponent[2] === 1;
    } catch { return false; }
  }
  return false;
}
async function verifySignature(input, signature, jwk, algorithm) {
  const importAlgorithm = algorithm === "ES256"
    ? { name: "ECDSA", namedCurve: "P-256" }
    : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const verifyAlgorithm = algorithm === "ES256"
    ? { name: "ECDSA", hash: "SHA-256" }
    : "RSASSA-PKCS1-v1_5";
  const key = await crypto.subtle.importKey("jwk", jwk, importAlgorithm, false, ["verify"]);
  return crypto.subtle.verify(verifyAlgorithm, key, signature, encoder.encode(input));
}

/** Verify a Supabase Auth user access token. This does not authorize a tenant or Core action. */
export async function verifySupabaseAuthToken(token, config, nowSeconds = Math.floor(Date.now() / 1000), fetcher = fetch) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH)
    throw new Error("missing_or_oversized_supabase_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed_supabase_token");
  const header = decodeJsonSegment(parts[0]);
  if (!header || Array.isArray(header) || !["ES256", "RS256"].includes(header.alg) ||
      typeof header.kid !== "string" || !header.kid || header.kid.length > MAX_KID_LENGTH ||
      header.crit !== undefined || header.b64 === false || header.jku !== undefined || header.x5u !== undefined)
    throw new Error("unsupported_supabase_token_algorithm");
  const issuer = configuredIssuer(config?.issuer);
  const audience = config?.audience;
  if (audience !== "authenticated") throw new Error("invalid_supabase_auth_audience_configuration");
  let keys = await fetchJwks(issuer, false, fetcher);
  let jwk = keys.find(candidate => signingKey(candidate, header));
  if (!jwk) {
    keys = await fetchJwks(issuer, true, fetcher);
    jwk = keys.find(candidate => signingKey(candidate, header));
  }
  if (!jwk) throw new Error("supabase_signing_key_not_found");
  let valid = false;
  try { valid = await verifySignature(parts[0] + "." + parts[1], decodeBase64Url(parts[2]), jwk, header.alg); }
  catch { valid = false; }
  if (!valid) throw new Error("supabase_signature_invalid");

  const claims = decodeJsonSegment(parts[1]);
  if (!claims || typeof claims !== "object" || Array.isArray(claims) || claims.iss !== issuer)
    throw new Error("unexpected_supabase_auth_issuer");
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (!Array.isArray(audiences) || !audiences.includes(audience))
    throw new Error("unexpected_supabase_auth_audience");
  if (typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 200 ||
      claims.sub.trim() !== claims.sub || /[\u0000-\u001f\u007f]/.test(claims.sub))
    throw new Error("supabase_user_identity_required");
  if (claims.role !== "authenticated" || claims.is_anonymous === true)
    throw new Error("supabase_authenticated_user_required");
  if (!Number.isInteger(claims.exp) || claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS)
    throw new Error("supabase_token_expired");
  if (!Number.isInteger(claims.iat) || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS || claims.exp <= claims.iat)
    throw new Error("supabase_token_issue_time_invalid");
  if (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) ||
      claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS || claims.nbf >= claims.exp))
    throw new Error("supabase_token_not_yet_valid");
  return Object.freeze({
    subject: claims.sub, issuer, audience,
    issuedAt: claims.iat,
    tokenId: typeof claims.jti === "string" ? claims.jti : null,
  });
}
