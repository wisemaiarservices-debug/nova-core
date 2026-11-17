import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign, webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
import {
  createNovaOsOwnerAuthorizationClient,
  verifyNovaOsOwnerAuthorizationPermit,
} from "../src/nova-os-owner-authorization.mjs";

const now = Math.floor(Date.now() / 1000);
const secret = "test-only-Core-to-OS-secret-with-at-least-32-bytes";
const keyId = "core-key-2026-11";
const permitKeyId = "nova-os-permit-key";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: permitKeyId,
  alg: "RS256", use: "sig", key_ops: ["verify"] };
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const input = {
  ownerAssertion: "header.payload.signature.test-long-token",
  displayName: "Research tenant",
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  assertionJti: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  idempotencyKey: "bootstrap-001",
  requestSha256: "a".repeat(64),
  supabaseIssuer: "https://project.example.test/auth/v1",
  supabaseSubject: "11111111-1111-4111-8111-111111111111",
  accessIssuer: "https://access.example.test",
  accessSubject: "owner@example.test",
  coreCorrelationId: "nova-provision:" + "a".repeat(64),
};

function signedPermit(expected, overrides = {}) {
  const header = Buffer.from(JSON.stringify({
    alg: "RS256", typ: "JWT", kid: permitKeyId,
  })).toString("base64url");
  const claims = {
    iss: "https://nova-os.example.test/authorization",
    aud: "nova-core-owner-authorization",
    sub: expected.accessSubject,
    access_issuer: expected.accessIssuer,
    access_subject: expected.accessSubject,
    supabase_issuer: expected.supabaseIssuer,
    supabase_subject: expected.supabaseSubject,
    nova_os_tenant_id: expected.tenantId,
    owner_assertion_jti: expected.assertionJti,
    idempotency_key: expected.idempotencyKey,
    request_sha256: expected.requestSha256,
    core_correlation_id: expected.coreCorrelationId,
    jti: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    iat: now,
    exp: now + 120,
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = header + "." + payload;
  return { token: signingInput + "." +
    sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url"), claims };
}

const config = () => ({
  endpoint: "https://project.example.test/functions/v1/nova-core-owner-authorization",
  keysJson: JSON.stringify({ [keyId]: secret }),
  activeKeyId: keyId,
  permitIssuer: "https://nova-os.example.test/authorization",
  permitAudience: "nova-core-owner-authorization",
  permitJwk: JSON.stringify(publicJwk),
});

test("Core client signs exact body, canonical path, key ID, timestamp and nonce; then verifies permit", async () => {
  const originalFetch = globalThis.fetch;
  const permit = signedPermit(input);
  let observedBody;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), config().endpoint);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    observedBody = JSON.parse(init.body);
    const headers = new Headers(init.headers);
    const bodyDigest = createHash("sha256").update(init.body).digest("hex");
    const canonical = ["POST", "/nova-core-owner-authorization", keyId,
      headers.get("x-nova-core-timestamp"), headers.get("x-nova-core-nonce"), bodyDigest].join("\n");
    assert.equal(headers.get("x-nova-core-key-id"), keyId);
    assert.equal(headers.get("x-nova-core-signature"),
      createHmac("sha256", secret).update(canonical).digest("hex"));
    return new Response(JSON.stringify({ data: {
      authorization_permit: permit.token,
      permit_jti: permit.claims.jti,
      expires_at: permit.claims.exp,
      replayed: false,
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = createNovaOsOwnerAuthorizationClient(config());
    const result = await client(input);
    assert.equal(result.permitJti, permit.claims.jti);
    assert.equal(result.permitKeyId, permitKeyId);
    assert.equal(observedBody.owner_assertion, input.ownerAssertion);
    assert.equal(observedBody.core_correlation_id, input.coreCorrelationId);
  } finally { globalThis.fetch = originalFetch; }
});

test("permit verifier rejects changed tenant, digest, key and audience", async () => {
  const permit = signedPermit(input);
  const verifierConfig = {
    issuer: "https://nova-os.example.test/authorization",
    audience: "nova-core-owner-authorization",
    jwk: JSON.stringify(publicJwk),
  };
  assert.equal((await verifyNovaOsOwnerAuthorizationPermit(permit.token,
    verifierConfig, input, now)).permitJti, permit.claims.jti);
  await assert.rejects(() => verifyNovaOsOwnerAuthorizationPermit(permit.token,
    verifierConfig, { ...input, requestSha256: "b".repeat(64),
      coreCorrelationId: "nova-provision:" + "b".repeat(64) }, now),
  /nova_os_authorization_permit_invalid/);
  await assert.rejects(() => verifyNovaOsOwnerAuthorizationPermit(permit.token,
    { ...verifierConfig, audience: "wrong-audience" }, input, now),
  /nova_os_authorization_permit_invalid/);
  await assert.rejects(() => verifyNovaOsOwnerAuthorizationPermit(permit.token,
    { ...verifierConfig, jwk: JSON.stringify({ ...publicJwk, kid: "wrong-key" }) }, input, now),
  /nova_os_authorization_permit_invalid|nova_os_authorization_not_configured/);
});

test("Core authorization client fails closed when endpoint or key-ring configuration is missing", () => {
  assert.throws(() => createNovaOsOwnerAuthorizationClient({ ...config(), endpoint: "http://localhost" }),
    /nova_os_authorization_not_configured/);
  assert.throws(() => createNovaOsOwnerAuthorizationClient({ ...config(), keysJson: "{}" }),
    /nova_os_authorization_not_configured/);
});


test("permit verifier rejects every substituted identity and request-binding claim", async () => {
  const verifierConfig = {
    issuer: "https://nova-os.example.test/authorization",
    audience: "nova-core-owner-authorization",
    jwk: JSON.stringify(publicJwk),
  };
  const mismatches = [
    { tenantId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    { assertionJti: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
    { idempotencyKey: "bootstrap-002" },
    { supabaseIssuer: "https://other-project.example.test/auth/v1" },
    { supabaseSubject: "22222222-2222-4222-8222-222222222222" },
    { accessIssuer: "https://other-access.example.test" },
    { accessSubject: "different-owner@example.test" },
    { requestSha256: "b".repeat(64), coreCorrelationId: "nova-provision:" + "b".repeat(64) },
  ];
  for (const mismatch of mismatches) {
    const alteredExpected = { ...input, ...mismatch };
    const permit = signedPermit(input);
    await assert.rejects(() => verifyNovaOsOwnerAuthorizationPermit(
      permit.token, verifierConfig, alteredExpected, now),
    /nova_os_authorization_permit_invalid/);
  }
});

test("permit verifier rejects expired, future-issued and overlong permits", async () => {
  const verifierConfig = {
    issuer: "https://nova-os.example.test/authorization",
    audience: "nova-core-owner-authorization",
    jwk: JSON.stringify(publicJwk),
  };
  const cases = [
    { iat: now - 121, exp: now - 1 },
    { iat: now + 31, exp: now + 100 },
    { iat: now - 10, exp: now + 121 },
  ];
  for (const claims of cases) {
    const permit = signedPermit(input, claims);
    await assert.rejects(() => verifyNovaOsOwnerAuthorizationPermit(
      permit.token, verifierConfig, input, now),
    /nova_os_authorization_permit_invalid/);
  }
});


test("Core client rejects oversized OS responses while streaming the body", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(20_000));
    },
    cancel() { cancelled = true; },
  }), { status: 200 });
  try {
    const client = createNovaOsOwnerAuthorizationClient(config());
    await assert.rejects(() => client(input), /nova_os_authorization_response_invalid/);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Core client rejects an oversized declared OS response before reading it", async () => {
  const originalFetch = globalThis.fetch;
  let read = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      read = true;
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {},
  }, { highWaterMark: 0 }), {
    status: 200,
    headers: { "content-length": "20000" },
  });
  try {
    const client = createNovaOsOwnerAuthorizationClient(config());
    await assert.rejects(() => client(input), /nova_os_authorization_response_invalid/);
    assert.equal(read, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Core client accepts a response exactly at the 16 KiB byte limit", async () => {
  const originalFetch = globalThis.fetch;
  const exactLimitJson = "{}" + " ".repeat(16_384 - 2);
  globalThis.fetch = async () => new Response(exactLimitJson, { status: 200 });
  try {
    const client = createNovaOsOwnerAuthorizationClient(config());
    await assert.rejects(() => client(input), /nova_os_authorization_permit_invalid/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Core client rejects malformed declared response lengths before reading", async () => {
  const originalFetch = globalThis.fetch;
  let read = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      read = true;
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {},
  }, { highWaterMark: 0 }), {
    status: 200,
    headers: { "content-length": "16 KiB" },
  });
  try {
    const client = createNovaOsOwnerAuthorizationClient(config());
    await assert.rejects(() => client(input), /nova_os_authorization_response_invalid/);
    assert.equal(read, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Core client normalizes response stream read failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull() {
      throw new Error("upstream-secret-detail");
    },
  }), { status: 200 });
  try {
    const client = createNovaOsOwnerAuthorizationClient(config());
    await assert.rejects(
      () => client(input),
      error => error.message === "nova_os_authorization_response_invalid" &&
        !error.message.includes("upstream-secret-detail"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Core client rejects invalid UTF-8 response bytes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([0xc3, 0x28]), { status: 200 });
  try {
    const client = createNovaOsOwnerAuthorizationClient(config());
    await assert.rejects(() => client(input), /nova_os_authorization_response_invalid/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
