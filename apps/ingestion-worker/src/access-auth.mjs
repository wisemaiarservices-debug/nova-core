const textEncoder = new TextEncoder();
const jwksCache = new Map();
const JWKS_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

function decodeBase64Url(segment) {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonSegment(segment) {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
  } catch {
    throw new Error("malformed_access_token");
  }
}

function issuerUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("invalid_access_issuer"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw new Error("invalid_access_issuer");
  }
  return parsed.origin;
}

async function fetchJwks(issuer, forceRefresh = false) {
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  let response;
  try {
    response = await fetch(issuer + "/cdn-cgi/access/certs", {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
  } catch {
    throw new Error("access_jwks_unavailable");
  }
  if (!response.ok) throw new Error("access_jwks_unavailable");
  let document;
  try {
    document = await response.json();
  } catch {
    throw new Error("access_jwks_invalid");
  }
  if (!document || !Array.isArray(document.keys) || document.keys.length === 0) {
    throw new Error("access_jwks_invalid");
  }
  jwksCache.set(issuer, { keys: document.keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return document.keys;
}

async function verifySignature(signingInput, signature, jwk) {
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, signature, textEncoder.encode(signingInput),
  );
}

export async function verifyAccessServiceToken(token, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string" || token.length > 16_384) throw new Error("missing_or_oversized_access_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed_access_token");

  const header = decodeJsonSegment(parts[0]);
  const claims = decodeJsonSegment(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    throw new Error("unsupported_access_token_algorithm");
  }

  const issuer = issuerUrl(config.issuer);
  if (claims.iss !== issuer) throw new Error("unexpected_access_issuer");
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (!Array.isArray(audiences) || !audiences.includes(config.audience)) {
    throw new Error("unexpected_access_audience");
  }
  if (claims.type !== "app" || claims.sub !== "" ||
      (claims.service_token_status !== undefined && claims.service_token_status !== true)) {
    throw new Error("service_token_required");
  }
  if (typeof claims.common_name !== "string" || !claims.common_name.trim()) {
    throw new Error("service_identity_missing");
  }
  if (!Number.isInteger(claims.exp) || claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new Error("access_token_expired");
  }
  if (!Number.isInteger(claims.iat) || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
      claims.exp <= claims.iat) {
    throw new Error("access_token_issue_time_invalid");
  }
  if (claims.nbf !== undefined &&
      (!Number.isInteger(claims.nbf) || claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS ||
       claims.nbf >= claims.exp)) {
    throw new Error("access_token_not_yet_valid");
  }

  let keys = await fetchJwks(issuer);
  let jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA" && candidate.use !== "enc");
  if (!jwk) {
    keys = await fetchJwks(issuer, true);
    jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA" && candidate.use !== "enc");
  }
  if (!jwk) throw new Error("access_signing_key_not_found");

  let valid = false;
  try {
    valid = await verifySignature(parts[0] + "." + parts[1], decodeBase64Url(parts[2]), jwk);
  } catch { valid = false; }
  if (!valid) throw new Error("access_signature_invalid");

  return Object.freeze({
    serviceId: claims.common_name,
    issuer,
    audience: config.audience,
    tokenId: typeof claims.jti === "string" ? claims.jti : null,
  });
}

export function parseServiceGrants(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("service_grants_invalid_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error("service_grants_must_be_nonempty_object");
  }
  const allowedModules = new Set(["nova-core", "neoagro", "neogrid", "neocell"]);
  const grants = new Map();
  for (const [serviceId, moduleMap] of Object.entries(parsed)) {
    if (!serviceId.trim() || serviceId.trim() !== serviceId ||
        !moduleMap || typeof moduleMap !== "object" || Array.isArray(moduleMap) ||
        Object.keys(moduleMap).length === 0) {
      throw new Error("service_grant_invalid");
    }
    const normalized = new Map();
    for (const [module, sourceIds] of Object.entries(moduleMap)) {
      if (!allowedModules.has(module) || !Array.isArray(sourceIds) || sourceIds.length === 0) {
        throw new Error("module_grant_invalid");
      }
      if (sourceIds.some((source) => typeof source !== "string" ||
          !source.trim() || source.trim() !== source || source === "*")) {
        throw new Error("source_grant_invalid");
      }
      if (new Set(sourceIds).size !== sourceIds.length) throw new Error("duplicate_source_grant");
      normalized.set(module, new Set(sourceIds));
    }
    grants.set(serviceId, normalized);
  }
  return grants;
}

export function authorizeServiceSource(principal, module, sourceId, grants) {
  if (!principal || !principal.serviceId || !grants.has(principal.serviceId)) {
    throw new Error("service_not_authorized");
  }
  const sources = grants.get(principal.serviceId).get(module);
  if (!sources || !sources.has(sourceId)) throw new Error("module_source_not_authorized");
  return true;
}
