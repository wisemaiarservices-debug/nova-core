import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { createNovaOsProvisioningReceiptSigner } from "../src/nova-os-provisioning-receipt.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "core-receipt-key-1", alg: "RS256", use: "sig" };
const config = {
  issuer: "https://nova-core.example.test/provisioning",
  audience: "https://nova-os.example.test/mapping",
  keyId: "core-receipt-key-1",
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const claims = {
  accessIssuer: "https://access.example.test",
  accessSubject: "access-owner-1",
  supabaseIssuer: "https://project.example.test/auth/v1",
  supabaseSubject: "supabase-owner-1",
  novaOsTenantId: "nova-tenant-1",
  coreTenantId: "tenant-core-1",
  idempotencyKey: "provision-tenant-1",
  requestDigest: "a".repeat(64),
  ownerAssertionJti: "aaaaaaaa-0000-4000-8000-000000000001",
  jti: "provisioning-request-1",
};

function decode(value) {
  return JSON.parse(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

test("Core signs a short-lived RS256 receipt binding both identities and both tenant IDs", async () => {
  const signer = await createNovaOsProvisioningReceiptSigner(config);
  const result = await signer(claims);
  const [headerPart, payloadPart, signaturePart] = result.token.split(".");
  const header = decode(headerPart);
  const payload = decode(payloadPart);
  assert.deepEqual(header, { alg: "RS256", typ: "JWT", kid: config.keyId });
  assert.equal(payload.iss, config.issuer);
  assert.equal(payload.aud, config.audience);
  assert.equal(payload.access_issuer, claims.accessIssuer);
  assert.equal(payload.access_subject, claims.accessSubject);
  assert.equal(payload.supabase_issuer, claims.supabaseIssuer);
  assert.equal(payload.supabase_subject, claims.supabaseSubject);
  assert.equal(payload.nova_os_tenant_id, claims.novaOsTenantId);
  assert.equal(payload.core_tenant_id, claims.coreTenantId);
  assert.equal(payload.idempotency_key, claims.idempotencyKey);
  assert.equal(payload.request_sha256, claims.requestDigest);
  assert.equal(payload.owner_assertion_jti, claims.ownerAssertionJti);
  assert.equal(payload.jti, claims.jti);
  assert.ok(payload.exp - payload.iat <= 300);
  assert.equal(result.jti, claims.jti);
  assert.equal(result.expiresAt, payload.exp);

  const key = await crypto.subtle.importKey("jwk", publicJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
    Buffer.from(signaturePart.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    new TextEncoder().encode(headerPart + "." + payloadPart));
  assert.equal(valid, true);
});

test("receipt signer rejects missing, weak, or invalid signing configuration", async () => {
  await assert.rejects(() => createNovaOsProvisioningReceiptSigner({
    ...config, issuer: "http://insecure.example.test/issuer",
  }), /invalid_nova_os_receipt_signing_configuration/);
  await assert.rejects(() => createNovaOsProvisioningReceiptSigner({
    ...config, privateKeyPem: "not a private key",
  }), /invalid_nova_os_receipt_signing_configuration/);
  const { privateKey: weakKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  await assert.rejects(() => createNovaOsProvisioningReceiptSigner({
    ...config,
    privateKeyPem: weakKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }), /invalid_nova_os_receipt_signing_configuration/);
  const signer = await createNovaOsProvisioningReceiptSigner(config);
  await assert.rejects(() => signer({ ...claims, requestDigest: "not-a-sha256" }),
    /invalid_nova_os_receipt_claims/);
  await assert.rejects(() => signer({ ...claims, ownerAssertionJti: "not-a-uuid" }),
    /invalid_nova_os_receipt_claims/);
});

test("receipt identifier remains stable across retries for the same durable provisioning request", async () => {
  const signer = await createNovaOsProvisioningReceiptSigner(config);
  const first = await signer(claims);
  const retry = await signer(claims);
  assert.equal(first.jti, retry.jti);
  assert.equal(decode(first.token.split(".")[1]).jti, decode(retry.token.split(".")[1]).jti);
});

test("receipt signer imports its private RSA key as non-extractable", async () => {
  const originalImportKey = crypto.subtle.importKey;
  let importedPrivateKey;
  try {
    crypto.subtle.importKey = async function (...args) {
      const key = await originalImportKey.apply(this, args);
      if (args[0] === "pkcs8") importedPrivateKey = key;
      return key;
    };
    await createNovaOsProvisioningReceiptSigner(config);
    assert.ok(importedPrivateKey);
    assert.equal(importedPrivateKey.extractable, false);
    assert.deepEqual(importedPrivateKey.usages, ["sign"]);
  } finally {
    crypto.subtle.importKey = originalImportKey;
  }
});
