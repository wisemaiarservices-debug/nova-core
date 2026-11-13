import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { verifyHumanAccessToken } from "../src/human-access-auth.mjs";
globalThis.crypto ??= webcrypto;
const audience = "nova-human-app-audience";
const now = 1_800_000_100;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const jwk = createPublicKey(publicKey).export({ format: "jwk" });
Object.assign(jwk, { kid: "human-test-key", use: "sig", alg: "RS256" });
const originalFetch = globalThis.fetch;
const issuerFor = label => "https://" + label + ".cloudflareaccess.com";
function b64url(value) { return Buffer.from(value).toString("base64url"); }
function tokenFor(issuer, overrides = {}, headerOverrides = {}) {
  const header = { alg: "RS256", typ: "JWT", kid: "human-test-key", ...headerOverrides };
  const claims = { iss: issuer, aud: [audience], sub: "immutable-user-subject-001",
    email: "operator@example.test", iat: now - 10, exp: now + 600, jti: "human-jti", ...overrides };
  const input = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}
function mockJwks(keys = [jwk]) {
  globalThis.fetch = async () => new Response(JSON.stringify({ keys }), { status: 200,
    headers: { "content-type": "application/json" } });
}
test.beforeEach(() => mockJwks());
test.after(() => { globalThis.fetch = originalFetch; });
test("verifies signature and returns stable human subject", async () => {
  const issuer = issuerFor("human-valid");
  const principal = await verifyHumanAccessToken(tokenFor(issuer), { issuer, audience }, now);
  assert.equal(principal.subject, "immutable-user-subject-001");
  assert.equal(principal.email, "operator@example.test");
  assert.equal(principal.audience, audience);
  assert.equal(principal.tokenId, "human-jti");
  assert.equal(Object.isFrozen(principal), true);
});

test("accepts the maximum subject length supported by tenant membership storage", async () => {
  const issuer = issuerFor("human-subject-boundary");
  const principal = await verifyHumanAccessToken(
    tokenFor(issuer, { sub: "s".repeat(200) }), { issuer, audience }, now);
  assert.equal(principal.subject.length, 200);
});

test("does not confuse the Access app token type with a service token", async () => {
  const issuer = issuerFor("human-type-app");
  const principal = await verifyHumanAccessToken(tokenFor(issuer, { type: "app" }), { issuer, audience }, now);
  assert.equal(principal.subject, "immutable-user-subject-001");
});
test("accepts exact string audience", async () => {
  const issuer = issuerFor("human-single-aud");
  assert.equal((await verifyHumanAccessToken(tokenFor(issuer, { aud: audience }), { issuer, audience }, now)).subject,
    "immutable-user-subject-001");
});
test("rejects forged signature", async () => {
  const issuer = issuerFor("human-forged");
  const parts = tokenFor(issuer).split(".");
  parts[1] = b64url(JSON.stringify({ iss: issuer, aud: audience, sub: "attacker-controlled", iat: now - 10, exp: now + 600 }));
  await assert.rejects(() => verifyHumanAccessToken(parts.join("."), { issuer, audience }, now), /access_signature_invalid/);
});
for (const [name, claims] of [
  ["empty subject", { sub: "" }], ["missing subject", { sub: undefined }],
  ["service token", { sub: "", type: "app", common_name: "service-client" }],
  ["service common name", { common_name: "service-client" }],
  ["wrong issuer", { iss: "https://attacker.example" }], ["wrong audience", { aud: ["other-app"] }],
  ["expired", { exp: now - 120 }], ["future iat", { iat: now + 120 }],
  ["expiry before iat", { iat: now + 10, exp: now }], ["invalid nbf", { nbf: now + 700 }],
  ["invalid email", { email: ["not-an-email"] }], ["subject exceeds tenant identity schema limit", { sub: "x".repeat(201) }],
]) test("rejects " + name, async () => {
  const issuer = issuerFor("human-reject-" + name.replaceAll(" ", "-"));
  await assert.rejects(() => verifyHumanAccessToken(tokenFor(issuer, claims), { issuer, audience }, now));
});
test("rejects malformed, oversized and unsupported tokens", async () => {
  const issuer = issuerFor("human-malformed");
  await assert.rejects(() => verifyHumanAccessToken("x.y", { issuer, audience }, now));
  await assert.rejects(() => verifyHumanAccessToken("x".repeat(16_385), { issuer, audience }, now));
  await assert.rejects(() => verifyHumanAccessToken(tokenFor(issuer, {}, { alg: "HS256" }), { issuer, audience }, now));
});
test("rejects unsafe issuer and missing audience configuration", async () => {
  const issuer = issuerFor("human-config");
  const token = tokenFor(issuer);
  await assert.rejects(() => verifyHumanAccessToken(token, { issuer: issuer + "/path", audience }, now), /invalid_access_issuer/);
  await assert.rejects(() => verifyHumanAccessToken(token, { issuer, audience: "" }, now), /invalid_access_audience_configuration/);
});
test("refreshes JWKS once when key ID is unknown", async () => {
  const issuer = issuerFor("human-key-rotation"); let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: calls++ === 0 ? [{ ...jwk, kid: "previous-key" }] : [jwk] }), { status: 200 });
  const principal = await verifyHumanAccessToken(tokenFor(issuer), { issuer, audience }, now);
  assert.equal(principal.subject, "immutable-user-subject-001"); assert.equal(calls, 2);
});
test("fails closed when JWKS provider is unavailable", async () => {
  const issuer = issuerFor("human-jwks-down"); globalThis.fetch = async () => { throw new Error("private detail"); };
  await assert.rejects(() => verifyHumanAccessToken(tokenFor(issuer), { issuer, audience }, now), /access_jwks_unavailable/);
});
test("fails closed for malformed JWKS", async () => {
  const issuer = issuerFor("human-jwks-invalid"); globalThis.fetch = async () => new Response("not-json", { status: 200 });
  await assert.rejects(() => verifyHumanAccessToken(tokenFor(issuer), { issuer, audience }, now), /access_jwks_invalid/);
});
test("uses configured issuer, not token issuer, for key lookup", async () => {
  const configuredIssuer = issuerFor("human-configured"); let requested = "";
  globalThis.fetch = async url => { requested = String(url); return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }); };
  await assert.rejects(() => verifyHumanAccessToken(tokenFor("https://attacker.example"),
    { issuer: configuredIssuer, audience }, now), /unexpected_access_issuer/);
  assert.equal(requested, configuredIssuer + "/cdn-cgi/access/certs");
});

test("rejects an oversized JWKS response before parsing", async () => {
  const issuer = issuerFor("human-jwks-oversized");
  globalThis.fetch = async () => new Response(" ".repeat(65_537), { status: 200 });
  await assert.rejects(() => verifyHumanAccessToken(tokenFor(issuer), { issuer, audience }, now), /access_jwks_invalid/);
});
test("rejects too many or duplicate JWKS key identifiers", async () => {
  const issuer = issuerFor("human-jwks-duplicate");
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: Array.from({ length: 33 }, (_, i) => ({ ...jwk, kid: "k" + i })) }), { status: 200 });
  await assert.rejects(() => verifyHumanAccessToken(tokenFor(issuer), { issuer, audience }, now), /access_jwks_invalid/);
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk, jwk] }), { status: 200 });
  await assert.rejects(() => verifyHumanAccessToken(tokenFor(issuer), { issuer, audience }, now), /access_jwks_invalid/);
});
test("rejects weak RSA signing keys", async () => {
  const issuer = issuerFor("human-jwks-weak-key");
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [{ ...jwk, n: Buffer.from([1, 2, 3]).toString("base64url") }] }), { status: 200 });
  await assert.rejects(() => verifyHumanAccessToken(tokenFor(issuer), { issuer, audience }, now), /access_signing_key_not_found/);
});
test("rejects unsupported critical and remote-key JWT headers", async () => {
  const issuer = issuerFor("human-header-extensions");
  for (const header of [{ crit: ["exp"] }, { b64: false }, { jku: "https://attacker.example/jwks" }, { x5u: "https://attacker.example/cert" }]) {
    await assert.rejects(() => verifyHumanAccessToken(tokenFor(issuer, {}, header), { issuer, audience }, now), /unsupported_access_token_algorithm/);
  }
});
