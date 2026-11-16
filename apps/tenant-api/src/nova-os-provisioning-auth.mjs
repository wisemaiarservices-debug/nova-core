const encoder = new TextEncoder();
const MAX_TOKEN_LENGTH = 16_384;
const CLOCK_SKEW_SECONDS = 30;
const MAX_ASSERTION_LIFETIME_SECONDS = 300;

function decodePart(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid_nova_os_owner_assertion");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  try { return Uint8Array.from(atob(padded), character => character.charCodeAt(0)); }
  catch { throw new Error("invalid_nova_os_owner_assertion"); }
}

function decodeJson(value) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodePart(value)));
  } catch {
    throw new Error("invalid_nova_os_owner_assertion");
  }
}

function validHttpsIdentifier(value, maxLength) {
  if (typeof value !== "string" || !value || value.length > maxLength || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname !== "/";
  } catch { return false; }
}

function configuredJwk(value, kid) {
  let jwk;
  try { jwk = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new Error("invalid_nova_os_provisioning_configuration"); }
  if (!jwk || Array.isArray(jwk) || jwk.kty !== "RSA" || jwk.kid !== kid ||
      typeof jwk.n !== "string" || typeof jwk.e !== "string" ||
      (jwk.alg !== undefined && jwk.alg !== "RS256") ||
      (jwk.use !== undefined && jwk.use !== "sig") ||
      (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify"))) ||
      jwk.d !== undefined || jwk.p !== undefined || jwk.q !== undefined) {
    throw new Error("invalid_nova_os_provisioning_configuration");
  }
  const modulus = decodePart(jwk.n);
  const exponent = decodePart(jwk.e);
  if (modulus.length < 256 || modulus[0] < 0x80 ||
      exponent.length !== 3 || exponent[0] !== 1 || exponent[1] !== 0 || exponent[2] !== 1) {
    throw new Error("invalid_nova_os_provisioning_configuration");
  }
  return jwk;
}

/**
 * Verify the NOVA OS server-signed proof that the authenticated Supabase user
 * is an active owner of the exact NOVA OS tenant being provisioned.
 *
 * The public JWK is pinned in Core Worker configuration. No token-controlled
 * key URL or algorithm is accepted.
 */
export async function verifyNovaOsOwnerAssertion(token, config, expected, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof config?.issuer !== "string" || !validHttpsIdentifier(config.issuer, 500) ||
      typeof config?.audience !== "string" || !config.audience.trim() || config.audience.length > 256) {
    throw new Error("invalid_nova_os_provisioning_configuration");
  }
  if (typeof token !== "string" || token.length < 32 || token.length > MAX_TOKEN_LENGTH ||
      !expected || typeof expected.supabaseIssuer !== "string" ||
      typeof expected.supabaseSubject !== "string" || typeof expected.novaOsTenantId !== "string") {
    throw new Error("invalid_nova_os_owner_assertion");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_nova_os_owner_assertion");
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!header || Array.isArray(header) || header.alg !== "RS256" ||
      typeof header.kid !== "string" || !header.kid || header.kid.length > 256 ||
      header.crit !== undefined || header.b64 === false || header.jku !== undefined || header.x5u !== undefined ||
      !claims || Array.isArray(claims)) {
    throw new Error("invalid_nova_os_owner_assertion");
  }
  const jwk = configuredJwk(config.jwk, header.kid);
  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey("jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch {
    throw new Error("invalid_nova_os_provisioning_configuration");
  }
  let valid = false;
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey,
      decodePart(parts[2]), encoder.encode(parts[0] + "." + parts[1]));
  } catch { valid = false; }
  if (!valid) throw new Error("invalid_nova_os_owner_assertion");

  const now = nowSeconds;
  if (claims.iss !== config.issuer || claims.aud !== config.audience ||
      claims.sub !== expected.supabaseSubject ||
      claims.supabase_issuer !== expected.supabaseIssuer ||
      claims.nova_os_tenant_id !== expected.novaOsTenantId ||
      claims.role !== "owner" || claims.membership_status !== "active" ||
      claims.tenant_status !== "active" ||
      !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
      claims.iat > now + CLOCK_SKEW_SECONDS || claims.iat < now - MAX_ASSERTION_LIFETIME_SECONDS ||
      claims.exp <= now || claims.exp <= claims.iat ||
      claims.exp - claims.iat > MAX_ASSERTION_LIFETIME_SECONDS ||
      typeof claims.jti !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.jti)) {
    throw new Error("invalid_nova_os_owner_assertion");
  }
  if (claims.nbf !== undefined &&
      (!Number.isInteger(claims.nbf) || claims.nbf > now + CLOCK_SKEW_SECONDS)) {
    throw new Error("invalid_nova_os_owner_assertion");
  }
  return Object.freeze({
    issuer: claims.iss,
    audience: claims.aud,
    supabaseIssuer: claims.supabase_issuer,
    supabaseSubject: claims.sub,
    novaOsTenantId: claims.nova_os_tenant_id,
    jti: claims.jti,
    issuedAt: claims.iat,
    expiresAt: claims.exp,
  });
}
