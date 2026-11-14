import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifySupabaseAccessToken } from "../src/supabase-access-auth.mjs";

const issuer = "https://project-ref.supabase.co/auth/v1";
const audience = "authenticated";
const now = 1_800_000_000;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "supabase-key-1", alg: "RS256", use: "sig", key_ops: ["verify"] };
function b64(value) { return Buffer.from(value).toString("base64url"); }
function token(claimOverrides = {}, headerOverrides = {}) {
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid, ...headerOverrides }));
  const claims = b64(JSON.stringify({
    iss: issuer, aud: audience, sub: "supabase-user-123", role: "authenticated",
    iat: now - 10, exp: now + 300, ...claimOverrides,
  }));
  const input = header + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}
const fetcher = async url => {
  assert.equal(url, issuer + "/.well-known/jwks.json");
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
};
const config = { issuer, audience };

test("verifies Supabase asymmetric token and returns only issuer-bound identity", async () => {
  const identity = await verifySupabaseAccessToken(token(), config, now, fetcher);
  assert.deepEqual(identity, { issuer, subject: "supabase-user-123", audience, issuedAt: now - 10, expiresAt: now + 300 });
  assert.equal(Object.isFrozen(identity), true);
});

test("rejects legacy HS256 and remote-key header injection", async () => {
  await assert.rejects(verifySupabaseAccessToken(token({}, { alg: "HS256" }), config, now, fetcher), /unsupported_supabase_token_algorithm/);
  await assert.rejects(verifySupabaseAccessToken(token({}, { jku: "https://attacker.test/jwks" }), config, now, fetcher), /unsupported_supabase_token_algorithm/);
});

test("rejects wrong issuer, audience, role, expired and not-yet-valid claims", async () => {
  for (const claims of [
    { iss: "https://attacker.test/auth/v1" }, { aud: "other" }, { role: "anon" },
    { exp: now - 120 }, { nbf: now + 120 },
  ]) await assert.rejects(verifySupabaseAccessToken(token(claims), config, now, fetcher));
});

test("rejects altered signature and unknown key identifier", async () => {
  const parts = token().split(".");
  parts[1] = b64(JSON.stringify({ iss: issuer, aud: audience, sub: "attacker", role: "authenticated", iat: now - 10, exp: now + 300 }));
  await assert.rejects(verifySupabaseAccessToken(parts.join("."), config, now, fetcher), /supabase_signature_invalid/);
  await assert.rejects(verifySupabaseAccessToken(token({}, { kid: "unknown" }), config, now, fetcher), /supabase_signing_key_not_found/);
});

test("rejects missing configuration and malformed or oversized JWKS", async () => {
  await assert.rejects(verifySupabaseAccessToken(token(), { issuer, audience: "" }, now, fetcher), /invalid_supabase_audience_configuration/);
  await assert.rejects(verifySupabaseAccessToken(token(), { issuer: "http://project-ref.supabase.co/auth/v1", audience }, now, fetcher), /invalid_supabase_issuer_configuration/);
  await assert.rejects(verifySupabaseAccessToken(token(), config, now, async () => new Response("{}", { status: 200 })), /supabase_jwks_invalid/);
  await assert.rejects(verifySupabaseAccessToken(token(), config, now, async () => new Response("x".repeat(70_000), { status: 200 })), /supabase_jwks_invalid/);
});

test("accepts signing-key rotation when the configured issuer publishes the new kid", async () => {
  const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rotatedJwk = { ...rotated.publicKey.export({ format: "jwk" }),
    kid: "supabase-key-rotated", alg: "RS256", use: "sig", key_ops: ["verify"] };
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: rotatedJwk.kid }));
  const claims = b64(JSON.stringify({
    iss: issuer, aud: audience, sub: "supabase-user-after-rotation",
    role: "authenticated", iat: now - 5, exp: now + 300,
  }));
  const input = header + "." + claims;
  const rotatedToken = input + "." + sign("RSA-SHA256", Buffer.from(input), rotated.privateKey).toString("base64url");
  const identity = await verifySupabaseAccessToken(rotatedToken, config, now, async url => {
    assert.equal(url, issuer + "/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [jwk, rotatedJwk] }), { status: 200 });
  });
  assert.equal(identity.subject, "supabase-user-after-rotation");
});

test("rejects ambiguous duplicate key identifiers in the issuer JWKS", async () => {
  await assert.rejects(verifySupabaseAccessToken(token(), config, now, async () =>
    new Response(JSON.stringify({ keys: [jwk, jwk] }), { status: 200 })), /supabase_jwks_invalid/);
});

test("rejects malformed compact tokens and malformed JWT JSON before trusting claims", async () => {
  for (const candidate of ["", "one.two", "a.b.c.d", "!.!.!", b64("[]") + "." + b64("{}") + ".AA"]) {
    await assert.rejects(verifySupabaseAccessToken(candidate, config, now, fetcher));
  }
});

test("rejects weak, non-RSA, encryption-only and wrong-exponent JWKS keys", async () => {
  const weak = { ...jwk, n: Buffer.alloc(128, 0xff).toString("base64url") };
  const ec = { ...jwk, kty: "EC" };
  const encryption = { ...jwk, use: "enc" };
  const wrongExponent = { ...jwk, e: Buffer.from([3]).toString("base64url") };
  for (const candidate of [weak, ec, encryption, wrongExponent]) {
    await assert.rejects(verifySupabaseAccessToken(token(), config, now, async () =>
      new Response(JSON.stringify({ keys: [candidate] }), { status: 200 })), /supabase_signing_key_not_found/);
  }
});

test("rejects duplicate or oversized key sets and non-success JWKS responses", async () => {
  await assert.rejects(verifySupabaseAccessToken(token(), config, now, async () =>
    new Response(JSON.stringify({ keys: Array.from({ length: 33 }, (_, i) => ({ ...jwk, kid: "k" + i })) }), { status: 200 })), /supabase_jwks_invalid/);
  await assert.rejects(verifySupabaseAccessToken(token(), config, now, async () =>
    new Response("unavailable", { status: 503 })), /supabase_jwks_unavailable/);
});

test("requires an exact configured issuer path and a non-empty bounded audience", async () => {
  for (const invalidIssuer of [
    "https://project-ref.supabase.co/auth/v1/",
    "https://project-ref.supabase.co/other/auth/v1",
    "https://project-ref.supabase.co/auth/v1?redirect=attacker",
    "https://project-ref.supabase.co/auth/v1#fragment",
  ]) {
    await assert.rejects(verifySupabaseAccessToken(token(), { issuer: invalidIssuer, audience }, now, fetcher),
      /invalid_supabase_issuer_configuration/);
  }
  await assert.rejects(verifySupabaseAccessToken(token(), { issuer, audience: " " }, now, fetcher),
    /invalid_supabase_audience_configuration/);
});
