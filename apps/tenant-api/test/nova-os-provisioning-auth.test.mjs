import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, webcrypto } from "node:crypto";
import { verifyNovaOsOwnerAssertion } from "../src/nova-os-provisioning-auth.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "nova-os-owner-proof-test";
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
const config = {
  issuer: "https://nova-os.example.test/provisioning",
  audience: "https://nova-core.example.test/tenants",
  jwk,
};
const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: config.issuer,
  aud: config.audience,
  sub: "supabase-owner-1",
  supabase_issuer: "https://project.example.test/auth/v1",
  nova_os_tenant_id: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  membership_status: "active",
  tenant_status: "active",
  iat: now,
  exp: now + 240,
  jti: "aaaaaaaa-0000-4000-8000-000000000001",
};
const expected = {
  supabaseIssuer: claims.supabase_issuer,
  supabaseSubject: claims.sub,
  novaOsTenantId: claims.nova_os_tenant_id,
};
function tokenFor(payload = claims, header = { alg: "RS256", typ: "JWT", kid }) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = encode(header) + "." + encode(payload);
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  return input + "." + signer.sign(privateKey).toString("base64url");
}

test("verifies a short-lived owner assertion and returns the exact identity/tenant binding", async () => {
  const result = await verifyNovaOsOwnerAssertion(tokenFor(), config, expected, now);
  assert.equal(result.supabaseIssuer, claims.supabase_issuer);
  assert.equal(result.supabaseSubject, claims.sub);
  assert.equal(result.novaOsTenantId, claims.nova_os_tenant_id);
  assert.equal(result.jti, claims.jti);
  assert.equal(result.expiresAt, claims.exp);
  assert.equal(Object.isFrozen(result), true);
});

test("rejects non-UUID owner assertion JTIs before provisioning can create a receipt", async () => {
  await assert.rejects(() => verifyNovaOsOwnerAssertion(
    tokenFor({ ...claims, jti: "owner-proof-1" }), config, expected, now,
  ), /invalid_nova_os_owner_assertion/);
});

test("rejects cross-user, cross-tenant, expired and token-directed-key assertions", async () => {
  await assert.rejects(() => verifyNovaOsOwnerAssertion(tokenFor(), config,
    { ...expected, supabaseSubject: "other-user" }, now), /invalid_nova_os_owner_assertion/);
  await assert.rejects(() => verifyNovaOsOwnerAssertion(tokenFor(), config,
    { ...expected, novaOsTenantId: "33333333-3333-4333-8333-333333333333" }, now),
  /invalid_nova_os_owner_assertion/);
  await assert.rejects(() => verifyNovaOsOwnerAssertion(
    tokenFor({ ...claims, exp: now - 1 }), config, expected, now,
  ), /invalid_nova_os_owner_assertion/);
  await assert.rejects(() => verifyNovaOsOwnerAssertion(tokenFor(claims, {
    alg: "RS256", typ: "JWT", kid, jku: "https://attacker.example/jwks",
  }), config, expected, now), /invalid_nova_os_owner_assertion/);
});


test("allows an expired but correctly signed owner assertion only when checking a committed retry", async () => {
  const expiredClaims = { ...claims, iat: now - 400, exp: now - 160 };
  await assert.rejects(() => verifyNovaOsOwnerAssertion(
    tokenFor(expiredClaims), config, expected, now,
  ), /invalid_nova_os_owner_assertion/);
  const result = await verifyNovaOsOwnerAssertion(
    tokenFor(expiredClaims), config, expected, now,
    { allowExpiredForCommittedRetry: true },
  );
  assert.equal(result.jti, claims.jti);
  assert.equal(result.expiresAt, expiredClaims.exp);
});
