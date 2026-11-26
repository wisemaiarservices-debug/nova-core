const encoder = new TextEncoder();

const MAX_ASSERTION_TTL_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 15;
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

function encodeJson(value) {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)));
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
 * Sign a short-lived request assertion for the private tenant API.
 *
 * verifiedAccessIdentity MUST be produced by a Cloudflare Access JWT verifier
 * operating on the cf-access-jwt-assertion token. This function deliberately
 * does not read identity headers or verify Access JWTs itself.
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
  if (!verifiedAccessIdentity || verifiedAccessIdentity.verified !== true) {
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
