import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { authorizeServiceSource, parseServiceGrants, verifyAccessServiceToken } from "../src/access-auth.mjs";

globalThis.crypto ??= webcrypto;
const issuer = "https://example.cloudflareaccess.com";
const audience = "nova-ingestion-audience";
const now = 1_800_000_100;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const jwk = createPublicKey(publicKey).export({ format: "jwk" });
Object.assign(jwk, { kid: "test-key-1", use: "sig", alg: "RS256" });
const originalFetch = globalThis.fetch;

function b64url(value) { return Buffer.from(value).toString("base64url"); }
function makeToken(overrides = {}) {
  const header = { alg: "RS256", typ: "JWT", kid: "test-key-1" };
  const claims = {
    iss: issuer, aud: [audience], type: "app", sub: "",
    common_name: "neoagro-ingestor", iat: now - 10, exp: now + 600, jti: "test-jti",
    ...overrides,
  };
  const input = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}

test.beforeEach(() => {
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
});
test.after(() => { globalThis.fetch = originalFetch; });

test("verifies RS256 signature and returns a server service principal", async () => {
  const principal = await verifyAccessServiceToken(makeToken(), { issuer, audience }, now);
  assert.equal(principal.serviceId, "neoagro-ingestor");
  assert.equal(principal.audience, audience);
  assert.equal(principal.tokenId, "test-jti");
});

test("rejects a modified token signature", async () => {
  const token = makeToken();
  const parts = token.split(".");
  parts[1] = b64url(JSON.stringify({ iss: issuer, aud: audience }));
  await assert.rejects(() => verifyAccessServiceToken(parts.join("."), { issuer, audience }, now));
});

for (const [name, overrides] of [
  ["wrong issuer", { iss: "https://attacker.example" }],
  ["wrong audience", { aud: ["another-audience"] }],
  ["non-service token", { type: "user" }],
  ["service token status false", { service_token_status: false }],
  ["non-empty subject", { sub: "user-subject" }],
  ["expired token", { exp: now - 120 }],
  ["future issue time", { iat: now + 120 }],
  ["expiry before issue time", { iat: now + 10, exp: now }],
  ["not-before after expiry", { nbf: now + 700 }],
  ["missing service identity", { common_name: "" }],
]) {
  test("rejects " + name, async () => {
    await assert.rejects(() => verifyAccessServiceToken(makeToken(overrides), { issuer, audience }, now));
  });
}

test("rejects issuer configuration containing a path", async () => {
  await assert.rejects(() => verifyAccessServiceToken(
    makeToken(),
    { issuer: issuer + "/unexpected-path", audience },
    now,
  ), /invalid_access_issuer/);
});

test("maps JWKS network failures to a controlled availability error", async () => {
  const isolatedIssuer = "https://network-failure.cloudflareaccess.com";
  globalThis.fetch = async () => { throw new Error("network details must not escape"); };
  await assert.rejects(
    () => verifyAccessServiceToken(makeToken({ iss: isolatedIssuer }), { issuer: isolatedIssuer, audience }, now),
    /access_jwks_unavailable/,
  );
});

test("maps malformed JWKS responses to a controlled validation error", async () => {
  const isolatedIssuer = "https://malformed-jwks.cloudflareaccess.com";
  globalThis.fetch = async () => new Response("not-json", { status: 200 });
  await assert.rejects(
    () => verifyAccessServiceToken(makeToken({ iss: isolatedIssuer }), { issuer: isolatedIssuer, audience }, now),
    /access_jwks_invalid/,
  );
});

test("rejects unsupported JWT algorithm", async () => {
  const header = b64url(JSON.stringify({ alg: "none", kid: "test-key-1" }));
  const payload = b64url(JSON.stringify({ iss: issuer, aud: audience }));
  await assert.rejects(() => verifyAccessServiceToken(header + "." + payload + ".x", { issuer, audience }, now));
});

test("allows exact service module source grant only", () => {
  const grants = parseServiceGrants(JSON.stringify({
    "neoagro-ingestor": { neoagro: ["source-weather-01", "source-soil-01"] },
  }));
  const principal = { serviceId: "neoagro-ingestor" };
  assert.equal(authorizeServiceSource(principal, "neoagro", "source-weather-01", grants), true);
  assert.throws(() => authorizeServiceSource(principal, "neogrid", "source-weather-01", grants));
  assert.throws(() => authorizeServiceSource(principal, "neoagro", "source-unknown", grants));
  assert.throws(() => authorizeServiceSource({ serviceId: "other" }, "neoagro", "source-weather-01", grants));
});

for (const invalid of [
  '{"service": {"neoagro": ["*"]}}',
  '{"service": {"neoagro": []}}',
  '{"service": {"unknown": ["source-1"]}}',
  '{"service": {"neoagro": ["source-1", "source-1"]}}',
  '{"service": {"neoagro": [" * "]}}',
  '{" service ": {"neoagro": ["source-1"]}}',
  '{"service": {}}',
  '[]',
]) {
  test("rejects unsafe service grant configuration", () => {
    assert.throws(() => parseServiceGrants(invalid));
  });
}
