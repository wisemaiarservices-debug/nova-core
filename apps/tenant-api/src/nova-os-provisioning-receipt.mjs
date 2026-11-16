const encoder = new TextEncoder();
const MAX_RECEIPT_SECONDS = 300;

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemBytes(value) {
  const normalized = value.replace(/\\n/g, "\n");
  const body = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  try { return Uint8Array.from(atob(body), character => character.charCodeAt(0)); }
  catch { throw new Error("invalid_nova_os_receipt_signing_configuration"); }
}

function validIssuer(value) {
  if (typeof value !== "string" || !value || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname !== "/" &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export async function createNovaOsProvisioningReceiptSigner(config) {
  if (!config || !validIssuer(config.issuer) ||
      typeof config.audience !== "string" || !config.audience ||
      config.audience.trim() !== config.audience || config.audience.length > 256 ||
      typeof config.keyId !== "string" || !config.keyId || config.keyId.length > 256 ||
      typeof config.privateKeyPem !== "string" || !config.privateKeyPem) {
    throw new Error("invalid_nova_os_receipt_signing_configuration");
  }
  let privateKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8", pemBytes(config.privateKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"],
    );
    const metadata = await crypto.subtle.exportKey("jwk", privateKey);
    const decode = value => Uint8Array.from(
      atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)),
      character => character.charCodeAt(0),
    );
    const modulus = typeof metadata.n === "string" ? decode(metadata.n) : new Uint8Array();
    const exponent = typeof metadata.e === "string" ? decode(metadata.e) : new Uint8Array();
    if (modulus.length < 256 || modulus[0] < 0x80 ||
        exponent.length !== 3 || exponent[0] !== 1 || exponent[1] !== 0 || exponent[2] !== 1) {
      throw new Error("invalid_nova_os_receipt_signing_configuration");
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message === "invalid_nova_os_receipt_signing_configuration") throw cause;
    throw new Error("invalid_nova_os_receipt_signing_configuration");
  }

  return async claims => {
    const required = [
      claims?.accessIssuer, claims?.accessSubject, claims?.supabaseIssuer,
      claims?.supabaseSubject, claims?.novaOsTenantId, claims?.coreTenantId,
      claims?.idempotencyKey, claims?.requestDigest, claims?.ownerAssertionJti, claims?.jti,
    ];
    if (required.some(value => typeof value !== "string" || !value || value.length > 512) ||
        !/^[a-f0-9]{64}$/.test(claims.requestDigest)) {
      throw new Error("invalid_nova_os_receipt_claims");
    }
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(encoder.encode(JSON.stringify({
      alg: "RS256", typ: "JWT", kid: config.keyId,
    })));
    const payload = base64Url(encoder.encode(JSON.stringify({
      iss: config.issuer,
      aud: config.audience,
      sub: claims.accessSubject,
      access_issuer: claims.accessIssuer,
      access_subject: claims.accessSubject,
      supabase_issuer: claims.supabaseIssuer,
      supabase_subject: claims.supabaseSubject,
      nova_os_tenant_id: claims.novaOsTenantId,
      core_tenant_id: claims.coreTenantId,
      idempotency_key: claims.idempotencyKey,
      request_sha256: claims.requestDigest,
      owner_assertion_jti: claims.ownerAssertionJti,
      jti: claims.jti,
      iat: now,
      exp: now + MAX_RECEIPT_SECONDS,
    })));
    const signingInput = header + "." + payload;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5", privateKey, encoder.encode(signingInput),
    );
    return {
      token: signingInput + "." + base64Url(new Uint8Array(signature)),
      expiresAt: now + MAX_RECEIPT_SECONDS,
      jti: claims.jti,
    };
  };
}
