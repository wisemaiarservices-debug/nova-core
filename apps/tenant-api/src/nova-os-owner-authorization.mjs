const encoder = new TextEncoder();
const MAX_RESPONSE_BYTES = 16_384;
const MAX_PERMIT_LIFETIME_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENDPOINT_PATH = "/nova-core-owner-authorization";

function opaque(value, max) {
  return typeof value === "string" && value.length >= 1 && value.length <= max &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function httpsIdentifier(value, max = 500) {
  if (!opaque(value, max)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname !== "/";
  } catch { return false; }
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("nova_os_authorization_permit_invalid");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  try { return Uint8Array.from(atob(padded), character => character.charCodeAt(0)); }
  catch { throw new Error("nova_os_authorization_permit_invalid"); }
}

function decodeJson(value) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value)));
  } catch { throw new Error("nova_os_authorization_permit_invalid"); }
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("nova_os_authorization_request_invalid");
  }
  return Uint8Array.from(value.match(/.{2}/g), pair => parseInt(pair, 16));
}

function configuredPublicJwk(value, kid) {
  let jwk;
  try { jwk = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new Error("nova_os_authorization_not_configured"); }
  if (!jwk || Array.isArray(jwk) || jwk.kty !== "RSA" || jwk.kid !== kid ||
      typeof jwk.n !== "string" || typeof jwk.e !== "string" ||
      (jwk.alg !== undefined && jwk.alg !== "RS256") ||
      (jwk.use !== undefined && jwk.use !== "sig") ||
      (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify"))) ||
      ["d","p","q","dp","dq","qi","oth"].some(name => jwk[name] !== undefined)) {
    throw new Error("nova_os_authorization_not_configured");
  }
  const modulus = decodeBase64Url(jwk.n);
  const exponent = decodeBase64Url(jwk.e);
  if (modulus.length < 256 || modulus[0] < 0x80 ||
      exponent.length !== 3 || exponent[0] !== 1 || exponent[1] !== 0 || exponent[2] !== 1) {
    throw new Error("nova_os_authorization_not_configured");
  }
  return jwk;
}

async function readBoundedResponse(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
    try { await response.body?.cancel(); } catch {}
    throw new Error("nova_os_authorization_response_invalid");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new Error("nova_os_authorization_response_invalid");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("nova_os_authorization_response_invalid");
  }
}

export async function verifyNovaOsOwnerAuthorizationPermit(token, config, expected,
  nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!httpsIdentifier(config?.issuer) || !opaque(config?.audience, 256) ||
      !opaque(config?.jwk, 8192)) {
    throw new Error("nova_os_authorization_not_configured");
  }
  if (typeof token !== "string" || token.length < 32 || token.length > MAX_RESPONSE_BYTES ||
      !expected || !UUID.test(expected.tenantId ?? "") ||
      !UUID.test(expected.supabaseSubject ?? "") ||
      !UUID.test(expected.assertionJti ?? "") ||
      !opaque(expected.supabaseIssuer, 500) ||
      !opaque(expected.accessIssuer, 500) ||
      !opaque(expected.accessSubject, 200) ||
      !opaque(expected.idempotencyKey, 160) ||
      !/^[a-f0-9]{64}$/.test(expected.requestSha256 ?? "") ||
      expected.coreCorrelationId !== "nova-provision:" + expected.requestSha256) {
    throw new Error("nova_os_authorization_permit_invalid");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("nova_os_authorization_permit_invalid");
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!header || Array.isArray(header) || header.alg !== "RS256" || header.typ !== "JWT" ||
      !opaque(header.kid, 80) || header.crit !== undefined || header.b64 === false ||
      header.jku !== undefined || header.x5u !== undefined ||
      !claims || Array.isArray(claims)) {
    throw new Error("nova_os_authorization_permit_invalid");
  }
  const jwk = configuredPublicJwk(config.jwk, header.kid);
  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey("jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch { throw new Error("nova_os_authorization_not_configured"); }
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey,
      decodeBase64Url(parts[2]), encoder.encode(parts[0] + "." + parts[1]));
  } catch { signatureValid = false; }
  if (!signatureValid) throw new Error("nova_os_authorization_permit_invalid");

  const valid =
    claims.iss === config.issuer &&
    claims.aud === config.audience &&
    claims.sub === expected.accessSubject &&
    claims.access_issuer === expected.accessIssuer &&
    claims.access_subject === expected.accessSubject &&
    claims.supabase_issuer === expected.supabaseIssuer &&
    claims.supabase_subject === expected.supabaseSubject &&
    claims.nova_os_tenant_id === expected.tenantId &&
    claims.owner_assertion_jti === expected.assertionJti &&
    claims.idempotency_key === expected.idempotencyKey &&
    claims.request_sha256 === expected.requestSha256 &&
    claims.core_correlation_id === expected.coreCorrelationId &&
    UUID.test(claims.jti ?? "") &&
    Number.isInteger(claims.iat) && Number.isInteger(claims.exp) &&
    claims.iat <= nowSeconds + CLOCK_SKEW_SECONDS &&
    claims.iat >= nowSeconds - MAX_PERMIT_LIFETIME_SECONDS &&
    claims.exp > nowSeconds && claims.exp > claims.iat &&
    claims.exp - claims.iat <= MAX_PERMIT_LIFETIME_SECONDS &&
    (claims.nbf === undefined ||
      (Number.isInteger(claims.nbf) && claims.nbf <= nowSeconds + CLOCK_SKEW_SECONDS));
  if (!valid) throw new Error("nova_os_authorization_permit_invalid");
  return Object.freeze({
    issuer: claims.iss,
    audience: claims.aud,
    permitJti: claims.jti,
    permitKeyId: header.kid,
    permitIssuedAt: claims.iat,
    permitExpiresAt: claims.exp,
    ownerAssertionJti: claims.owner_assertion_jti,
    tenantId: claims.nova_os_tenant_id,
    idempotencyKey: claims.idempotency_key,
    requestSha256: claims.request_sha256,
    coreCorrelationId: claims.core_correlation_id,
  });
}

export function createNovaOsOwnerAuthorizationClient(config) {
  if (!httpsIdentifier(config?.endpoint, 1000) ||
      !config.endpoint.endsWith("/functions/v1/nova-core-owner-authorization") ||
      !opaque(config?.keysJson, 8192) ||
      !/^[A-Za-z0-9._-]{1,80}$/.test(config?.activeKeyId ?? "") ||
      !httpsIdentifier(config?.permitIssuer) ||
      !opaque(config?.permitAudience, 256) ||
      !opaque(config?.permitJwk, 8192)) {
    throw new Error("nova_os_authorization_not_configured");
  }
  let keys;
  try { keys = JSON.parse(config.keysJson); }
  catch { throw new Error("nova_os_authorization_not_configured"); }
  const secret = keys && !Array.isArray(keys) && Object.hasOwn(keys, config.activeKeyId)
    ? keys[config.activeKeyId] : null;
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512) {
    throw new Error("nova_os_authorization_not_configured");
  }

  return async input => {
    if (!input || typeof input.ownerAssertion !== "string" ||
        input.ownerAssertion.length < 32 || input.ownerAssertion.length > 16_384 ||
        !UUID.test(input.tenantId ?? "") || !UUID.test(input.supabaseSubject ?? "") ||
        !UUID.test(input.assertionJti ?? "") ||
        !opaque(input.displayName, 160) || !opaque(input.supabaseIssuer, 500) || !opaque(input.accessIssuer, 500) ||
        !opaque(input.accessSubject, 200) || !opaque(input.idempotencyKey, 160) ||
        !/^[a-f0-9]{64}$/.test(input.requestSha256 ?? "") ||
        input.coreCorrelationId !== "nova-provision:" + input.requestSha256) {
      throw new Error("nova_os_authorization_request_invalid");
    }
    const body = JSON.stringify({
      owner_assertion: input.ownerAssertion,
      tenant_id: input.tenantId,
      display_name: input.displayName,
      idempotency_key: input.idempotencyKey,
      request_sha256: input.requestSha256,
      supabase_issuer: input.supabaseIssuer,
      supabase_subject: input.supabaseSubject,
      access_issuer: input.accessIssuer,
      access_subject: input.accessSubject,
      core_correlation_id: input.coreCorrelationId,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const bodyDigest = hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
    const signed = ["POST", ENDPOINT_PATH, config.activeKeyId, timestamp, nonce, bodyDigest].join("\n");
    const hmacKey = await crypto.subtle.importKey("raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = hex(await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(signed)));
    let response;
    try {
      response = await fetch(config.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-nova-core-key-id": config.activeKeyId,
          "x-nova-core-timestamp": timestamp,
          "x-nova-core-nonce": nonce,
          "x-nova-core-signature": signature,
        },
        body,
      });
    } catch {
      throw new Error("nova_os_authorization_unavailable");
    }
    const text = await readBoundedResponse(response);
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new Error("nova_os_authorization_response_invalid"); }
    if (!response.ok) {
      if (response.status === 403 && payload?.error === "owner_not_active") {
        throw new Error("nova_os_owner_not_active");
      }
      if (response.status === 409 && payload?.error === "authorization_conflict") {
        throw new Error("nova_os_authorization_conflict");
      }
      throw new Error("nova_os_authorization_unavailable");
    }
    const permitToken = payload?.data?.authorization_permit;
    const permit = await verifyNovaOsOwnerAuthorizationPermit(permitToken, {
      issuer: config.permitIssuer,
      audience: config.permitAudience,
      jwk: config.permitJwk,
    }, {
      tenantId: input.tenantId,
      assertionJti: input.assertionJti,
      idempotencyKey: input.idempotencyKey,
      requestSha256: input.requestSha256,
      supabaseIssuer: input.supabaseIssuer,
      supabaseSubject: input.supabaseSubject,
      accessIssuer: input.accessIssuer,
      accessSubject: input.accessSubject,
      coreCorrelationId: input.coreCorrelationId,
    });
    if (payload.data.permit_jti !== permit.permitJti ||
        !Number.isInteger(payload.data.expires_at) ||
        payload.data.expires_at !== permit.permitExpiresAt ||
        typeof payload.data.replayed !== "boolean") {
      throw new Error("nova_os_authorization_permit_invalid");
    }
    return permit;
  };
}
