const encoder = new TextEncoder();
const jwksCache = new Map();
const JWKS_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_JWKS_BYTES = 65_536;
const MAX_JWKS_KEYS = 32;
const MAX_KID_LENGTH = 256;
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
async function readBoundedBody(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\\d+$/.test(declaredLength) || Number(declaredLength) > MAX_JWKS_BYTES))
    throw new Error("access_jwks_invalid");
  if (!response.body) throw new Error("access_jwks_invalid");
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
        throw new Error("access_jwks_invalid");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("access_jwks_invalid"); }
}
async function fetchJwks(issuer, forceRefresh = false) {
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  let response;
  try { response = await fetch(issuer + "/cdn-cgi/access/certs", {
    method: "GET", redirect: "error",
    headers: { Accept: "application/json" }, cf: { cacheTtl: 300, cacheEverything: true },
  }); } catch { throw new Error("access_jwks_unavailable"); }
  if (!response.ok) throw new Error("access_jwks_unavailable");
  let document;
  try { document = JSON.parse(await readBoundedBody(response)); }
  catch (error) {
    if (error?.message === "access_jwks_invalid") throw error;
    throw new Error("access_jwks_invalid");
  }
  if (!document || !Array.isArray(document.keys) || document.keys.length === 0 ||
      document.keys.length > MAX_JWKS_KEYS) throw new Error("access_jwks_invalid");
  const kids = new Set();
  for (const key of document.keys) {
    if (!key || typeof key.kid !== "string" || !key.kid || key.kid.length > MAX_KID_LENGTH || kids.has(key.kid))
      throw new Error("access_jwks_invalid");
    kids.add(key.kid);
  }
  jwksCache.set(issuer, { keys: document.keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return document.keys;
}
