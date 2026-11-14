import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { verifySupabaseAuthToken } from "../src/supabase-auth.mjs";
globalThis.crypto ??= webcrypto;

const now = 1_800_000_100;
const audience = "authenticated";
const issuer = "https://project-ref.supabase.co/auth/v1";
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const jwk = { ...createPublicKey(publicKey).export({ format: "jwk" }), kid: "supabase-test-key", use: "sig", alg: "ES256" };
const originalFetch = globalThis.fetch;
function b64url(value) { return Buffer.from(value).toString("base64url"); }
function tokenFor(claimOverrides = {}, headerOverrides = {}, issuerValue = issuer) {
  const header = { alg: "ES256", typ: "JWT", kid: "supabase-test-key", ...headerOverrides };
  const claims = {
    iss: issuerValue, aud: audience, sub: "supabase-user-uuid-001", role: "authenticated",
    iat: now - 10, exp: now + 600, session_id: "session-test", ...claimOverrides,
  };
  const input = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));
  return input + "." + sign("SHA256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}
function mockJwks(keys = [jwk]) {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, issuer + "/.well-known/jwks.json");
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ keys }), { status: 200, headers: { "content-type": "application/json" } });
  };
}
test.beforeEach(() => mockJwks());
test.after(() => { globalThis.fetch = originalFetch; });

test("verifies Supabase ES256 signature and returns only immutable identity metadata", async () => {
  const principal = await verifySupabaseAuthToken(tokenFor(), { issuer, audience }, now);
  assert.equal(principal.subject, "supabase-user-uuid-001");
  assert.equal(principal.issuer, issuer);
  assert.equal(principal.audience, audience);
  assert.equal(Object.isFrozen(principal), true);
  assert.equal("email" in principal, false);
});
test("accepts exact authenticated audience as a string or array", async () => {
  assert.equal((await verifySupabaseAuthToken(tokenFor({ aud: ["authenticated"] }), { issuer, audience }, now)).subject,
    "supabase-user-uuid-001");
});
for (const [name, claims] of [
  ["wrong issuer", { iss: "https://attacker.example/auth/v1" }],
  ["wrong audience", { aud: "anon" }],
  ["service role", { role: "service_role" }],
  ["anonymous user", { is_anonymous: true }],
  ["missing subject", { sub: undefined }],
  ["oversized subject", { sub: "u".repeat(201) }],
  ["expired token", { exp: now - 120 }],
  ["future issue time", { iat: now + 120 }],
  ["expiry before issue", { iat: now + 10, exp: now }],
  ["not yet valid", { nbf: now + 700 }],
]) test("rejects " + name, async () => {
  await assert.rejects(() => verifySupabaseAuthToken(tokenFor(claims), { issuer, audience }, now));
});
test("rejects forged signatures", async () => {
  const parts = tokenFor().split(".");
  parts[1] = b64url(JSON.stringify({ iss: issuer, aud: audience, sub: "forged", role: "authenticated", iat: now - 10, exp: now + 600 }));
  await assert.rejects(() => verifySupabaseAuthToken(parts.join("."), { issuer, audience }, now), /supabase_signature_invalid/);
});
test("rejects malformed, oversized and unsupported tokens", async () => {
  await assert.rejects(() => verifySupabaseAuthToken("x.y", { issuer, audience }, now));
  await assert.rejects(() => verifySupabaseAuthToken("x".repeat(16_385), { issuer, audience }, now));
  await assert.rejects(() => verifySupabaseAuthToken(tokenFor({}, { alg: "HS256" }), { issuer, audience }, now));
});
test("rejects unsafe issuer and any audience other than authenticated", async () => {
  await assert.rejects(() => verifySupabaseAuthToken(tokenFor(), { issuer: "https://project-ref.supabase.co", audience }, now),
    /invalid_supabase_auth_issuer/);
  await assert.rejects(() => verifySupabaseAuthToken(tokenFor(), { issuer, audience: "anon" }, now),
    /invalid_supabase_auth_audience_configuration/);
});
test("refreshes JWKS once when the signing key rotates", async () => {
  const isolatedIssuer = "https://rotation-project.supabase.co/auth/v1";
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({
    keys: calls++ === 0 ? [{ ...jwk, kid: "previous-key" }] : [jwk],
  }), { status: 200 });
  const principal = await verifySupabaseAuthToken(tokenFor({}, {}, isolatedIssuer),
    { issuer: isolatedIssuer, audience }, now);
  assert.equal(principal.subject, "supabase-user-uuid-001");
  assert.equal(calls, 2);
});
test("fails closed when JWKS is unavailable or malformed", async () => {
  const isolatedIssuer = "https://unavailable-project.supabase.co/auth/v1";
  globalThis.fetch = async () => { throw new Error("private fetch details"); };
  await assert.rejects(() => verifySupabaseAuthToken(tokenFor({}, {}, isolatedIssuer),
    { issuer: isolatedIssuer, audience }, now), /supabase_jwks_unavailable/);
  const malformedIssuer = "https://malformed-project.supabase.co/auth/v1";
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [] }), { status: 200 });
  await assert.rejects(() => verifySupabaseAuthToken(tokenFor({}, {}, malformedIssuer),
    { issuer: malformedIssuer, audience }, now), /supabase_jwks_invalid/);
});
test("fails closed on JWKS redirects and oversized bodies", async () => {
  const redirectIssuer = "https://redirect-project.supabase.co/auth/v1";
  globalThis.fetch = async () => new Response("", { status: 302 });
  await assert.rejects(() => verifySupabaseAuthToken(tokenFor({}, {}, redirectIssuer),
    { issuer: redirectIssuer, audience }, now), /supabase_jwks_unavailable/);
  const oversizedIssuer = "https://oversized-project.supabase.co/auth/v1";
  globalThis.fetch = async () => new Response("x".repeat(65_537), { status: 200 });
  await assert.rejects(() => verifySupabaseAuthToken(tokenFor({}, {}, oversizedIssuer),
    { issuer: oversizedIssuer, audience }, now), /supabase_jwks_invalid/);
});
