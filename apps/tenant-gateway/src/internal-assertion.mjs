const encoder = new TextEncoder();
const verifiedAccessIdentities = new WeakSet();

const MAX_ASSERTION_TTL_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 15;
const MAX_ACCESS_TOKEN_LENGTH = 8192;
const MAX_JWKS_RESPONSE_BYTES = 64 * 1024;
const JWKS_FETCH_TIMEOUT_MS = 3000;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SUBJECT_PATTERN = /^[^\x00-\x20\x7f]{1,200}$/;
const JTI_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;
const RESOURCE_PATH_PATTERN =
  /^\/api\/v1\/tenants\/[A-Za-z0-9._~-]{1,120}\/(?:sites|assets|sources|observations|audit-events)\/[A-Za-z0-9._~-]{1,160}$/;

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(segment) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new TypeError("invalid base64url segment");
  }
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== segment) {
    throw new TypeError("non-canonical base64url segment");
  }
  return bytes;
}

export function assertNoDuplicateJsonMembers(source) {
  let index = 0;
  const whitespace = () => {
    while (index < source.length && /[\t\n\r ]/.test(source[index])) index += 1;
  };
  const string = () => {
    const start = index;
    if (source[index] !== '"') throw new TypeError("JSON string required");
    index += 1;
    while (index < source.length) {
      const character = source[index++];
      if (character === '"') {
        return JSON.parse(source.slice(start, index));
      }
      if (character === "\\") {
        if (index >= source.length) throw new TypeError("invalid JSON escape");
        index += 1;
      } else if (character.charCodeAt(0) < 0x20) {
        throw new TypeError("invalid JSON string");
      }
    }
    throw new TypeError("unterminated JSON string");
  };
  const value = () => {
    whitespace();
    if (source[index] === '"') {
      string();
      return;
    }
    if (source[index] === "{") {
      index += 1;
      whitespace();
      const keys = new Set();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      while (index < source.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new TypeError("duplicate JSON member");
        keys.add(key);
        whitespace();
        if (source[index++] !== ":") throw new TypeError("invalid JSON object");
        value();
        whitespace();
        const delimiter = source[index++];
        if (delimiter === "}") return;
        if (delimiter !== ",") throw new TypeError("invalid JSON object");
      }
      throw new TypeError("unterminated JSON object");
    }
    if (source[index] === "[") {
      index += 1;
      whitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      while (index < source.length) {
        value();
        whitespace();
        const delimiter = source[index++];
        if (delimiter === "]") return;
        if (delimiter !== ",") throw new TypeError("invalid JSON array");
      }
      throw new TypeError("unterminated JSON array");
    }
    const remaining = source.slice(index);
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(remaining);
    if (!primitive) throw new TypeError("invalid JSON value");
    index += primitive[0].length;
  };
  value();
  whitespace();
  if (index !== source.length) throw new TypeError("trailing JSON content");
}

function decodeJsonSegment(segment) {
  const bytes = decodeBase64Url(segment);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonMembers(source);
  const value = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("JWT object required");
  }
  return value;
}

function encodeJson(value) {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)));
}

function cancelReaderWithoutWaiting(reader, reason) {
  try {
    const cancellation = reader.cancel(reason);
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => {});
    }
  } catch {
    // Cancellation is best-effort; preserve the JWKS size rejection.
  }
}

function cancelBodyWithoutWaiting(body, reason) {
  try {
    const cancellation = body?.cancel(reason);
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => {});
    }
  } catch {
    // Cancellation is best-effort; preserve the JWKS size rejection.
  }
}

async function readBoundedJwksResponse(response) {
  if (!response || response.ok !== true || !response.headers || !response.body) {
    throw new TypeError("Cloudflare Access signing keys are unavailable");
  }
  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/(?:json|jwk-set\+json)(?:\s*;|$)/i.test(contentType)) {
    throw new TypeError("Cloudflare Access signing keys have an invalid content type");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_JWKS_RESPONSE_BYTES) {
      cancelBodyWithoutWaiting(response.body, "JWKS response exceeds size limit");
      throw new TypeError("Cloudflare Access signing-key response is too large");
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JWKS_RESPONSE_BYTES) {
        cancelReaderWithoutWaiting(reader, "JWKS response exceeds size limit");
        throw new TypeError("Cloudflare Access signing-key response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonMembers(source);
  let jwks;
  try {
    jwks = JSON.parse(source);
  } catch {
    throw new TypeError("Cloudflare Access signing keys contain invalid JSON");
  }
  return jwks;
}

function isInteger(value) {
  return Number.isSafeInteger(value);
}

function validatePath(path) {
  if (
    typeof path !== "string" ||
    !RESOURCE_PATH_PATTERN.test(path) ||
    path.split("/").some((segment) => segment === "." || segment === "..") ||
    path.includes("%") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new TypeError("private tenant request path is not allowed");
  }
}

function validateSubject(subject) {
  if (typeof subject !== "string" || !SUBJECT_PATTERN.test(subject)) {
    throw new TypeError("verified Access subject is invalid");
  }
}

/**
 * Verify Cloudflare Access JWT using the fixed team-domain JWKS endpoint.
 * A principal is branded in a module-private WeakSet only after RS256,
 * issuer, audience, subject and time claims all pass.
 */
export async function verifyCloudflareAccessJwt(
  token,
  { teamDomain, audience, now = Date.now(), fetchImpl = globalThis.fetch },
) {
  if (
    typeof token !== "string" ||
    !token ||
    token.length > MAX_ACCESS_TOKEN_LENGTH ||
    typeof teamDomain !== "string" ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain) ||
    typeof audience !== "string" ||
    !audience ||
    !isInteger(now) ||
    now <= 0 ||
    typeof fetchImpl !== "function"
  ) {
    throw new TypeError("Cloudflare Access verification configuration is invalid");
  }

  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw new TypeError("Cloudflare Access assertion is invalid");
  }

  const header = decodeJsonSegment(segments[0]);
  if (
    Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
    header.alg !== "RS256" ||
    header.typ !== "JWT" ||
    typeof header.kid !== "string" ||
    !KEY_ID_PATTERN.test(header.kid)
  ) {
    throw new TypeError("Cloudflare Access assertion header is invalid");
  }

  const issuer = `https://${teamDomain}`;
  const jwksUrl = `${issuer}/cdn-cgi/access/certs`;
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    throw new TypeError("Cloudflare Access signing-key timeout is unavailable");
  }
  const response = await fetchImpl(jwksUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    cf: { cacheTtl: 300 },
  });
  const jwks = await readBoundedJwksResponse(response);
  if (
    !jwks ||
    !Array.isArray(jwks.keys) ||
    jwks.keys.length < 1 ||
    jwks.keys.length > 20
  ) {
    throw new TypeError("Cloudflare Access signing keys are invalid");
  }
  const matchingKeys = jwks.keys.filter(
    (key) =>
      key &&
      key.kid === header.kid &&
      key.kty === "RSA" &&
      (key.use === undefined || key.use === "sig") &&
      (key.alg === undefined || key.alg === "RS256"),
  );
  if (matchingKeys.length !== 1) {
    throw new TypeError("Cloudflare Access signing key is unknown or ambiguous");
  }

  const publicKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    matchingKeys[0],
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = decodeBase64Url(segments[2]);
  const verified = await globalThis.crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature,
    encoder.encode(`${segments[0]}.${segments[1]}`),
  );
  if (!verified) {
    throw new TypeError("Cloudflare Access signature is invalid");
  }

  const claims = decodeJsonSegment(segments[1]);
  const nowSeconds = Math.floor(now / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== issuer ||
    !audiences.includes(audience) ||
    typeof claims.sub !== "string" ||
    !SUBJECT_PATTERN.test(claims.sub) ||
    !isInteger(claims.exp) ||
    claims.exp <= nowSeconds ||
    !isInteger(claims.nbf) ||
    claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS ||
    !isInteger(claims.iat) ||
    claims.iat > nowSeconds + CLOCK_SKEW_SECONDS
  ) {
    throw new TypeError("Cloudflare Access identity claims are invalid");
  }

  const identity = Object.freeze({ subject: claims.sub });
  verifiedAccessIdentities.add(identity);
  return identity;
}

/**
 * Sign a short-lived request assertion for the private tenant API.
 *
 * verifiedAccessIdentity MUST be returned by verifyCloudflareAccessJwt.
 * Plain objects, request headers and caller-supplied identity claims are not
 * accepted as authenticated principals.
 */
export async function createInternalAssertion({
  verifiedAccessIdentity,
  method,
  path,
  now = Date.now(),
  ttlSeconds = 60,
  keyId,
  secret,
  issuer,
  audience,
}) {
  if (
    !verifiedAccessIdentity ||
    typeof verifiedAccessIdentity !== "object" ||
    !verifiedAccessIdentities.has(verifiedAccessIdentity)
  ) {
    throw new TypeError("a verified Access identity is required");
  }
  validateSubject(verifiedAccessIdentity.subject);
  if (method !== "GET") {
    throw new TypeError("only read-only GET assertions are supported");
  }
  validatePath(path);
  if (!isInteger(now) || now <= 0) {
    throw new TypeError("current time must be a positive safe integer");
  }
  if (
    !isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > MAX_ASSERTION_TTL_SECONDS
  ) {
    throw new TypeError("assertion lifetime is outside the allowed range");
  }
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) {
    throw new TypeError("signing key identifier is invalid");
  }
  if (typeof secret !== "string" || encoder.encode(secret).byteLength < 32) {
    throw new TypeError("signing key material is unavailable or too short");
  }
  if (
    typeof issuer !== "string" || !issuer || issuer.length > 256 ||
    typeof audience !== "string" || !audience || audience.length > 256
  ) {
    throw new TypeError("assertion issuer or audience is not configured");
  }

  const issuedAt = Math.floor(now / 1000);
  const claims = {
    iss: issuer,
    aud: audience,
    sub: verifiedAccessIdentity.subject,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: globalThis.crypto.randomUUID(),
    method,
    path,
  };
  if (!JTI_PATTERN.test(claims.jti)) {
    throw new TypeError("generated request identifier is invalid");
  }

  const header = {
    alg: "HS256",
    typ: "NOVA-Internal-Request",
    kid: keyId,
  };
  const protectedSegment = encodeJson(header);
  const payloadSegment = encodeJson(claims);
  const signingInput = `${protectedSegment}.${payloadSegment}`;
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export const INTERNAL_ASSERTION_LIMITS = Object.freeze({
  maxLifetimeSeconds: MAX_ASSERTION_TTL_SECONDS,
  clockSkewSeconds: CLOCK_SKEW_SECONDS,
});
