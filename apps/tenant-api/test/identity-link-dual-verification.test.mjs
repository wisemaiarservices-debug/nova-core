import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { verifyIdentityLinkIdentityPair } from "../src/identity-link-dual-verification.mjs";

globalThis.crypto ??= webcrypto;

const ACCESS_ISSUER = "https://team.cloudflareaccess.com";
const ACCESS_AUDIENCE = "nova-core-access";
const SUPABASE_ISSUER = "https://project.example.test/auth/v1";
const SUPABASE_AUDIENCE = "authenticated";
const now = Math.floor(Date.now() / 1000);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "dual-link-test-key",
  alg: "RS256", use: "sig", key_ops: ["verify"] };
function b64(value) { return Buffer.from(value).toString("base64url"); }
function tokenFor(subject = "supabase-user") {
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
  const claims = b64(JSON.stringify({ iss: SUPABASE_ISSUER, aud: SUPABASE_AUDIENCE,
    sub: subject, role: "authenticated", iat: now - 5, exp: now + 300 }));
  const input = header + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}
const accessIdentity = Object.freeze({ issuer: ACCESS_ISSUER,
  subject: "cloudflare-access-user", audience: ACCESS_AUDIENCE });
const config = { accessIssuer: ACCESS_ISSUER, accessAudience: ACCESS_AUDIENCE,
  supabaseIssuer: SUPABASE_ISSUER, supabaseAudience: SUPABASE_AUDIENCE };

test("returns a minimal pair only after independent Supabase JWT verification", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), SUPABASE_ISSUER + "/.well-known/jwks.json");
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const pair = await verifyIdentityLinkIdentityPair({
      supabaseToken: tokenFor(), cloudflareIdentity: accessIdentity, ...config,
    });
    assert.deepEqual(pair.supabase, { issuer: SUPABASE_ISSUER,
      subject: "supabase-user", audience: SUPABASE_AUDIENCE });
    assert.deepEqual(pair.cloudflare, accessIdentity);
    assert.notEqual(pair.supabase.issuer, pair.cloudflare.issuer);
    assert.ok(Object.isFrozen(pair));
    assert.ok(Object.isFrozen(pair.supabase));
    assert.ok(Object.isFrozen(pair.cloudflare));
    assert.equal(Object.hasOwn(pair.supabase, "token"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects a Cloudflare identity whose issuer or audience is not the verified gateway configuration", async () => {
  await assert.rejects(() => verifyIdentityLinkIdentityPair({
    supabaseToken: tokenFor(),
    cloudflareIdentity: { ...accessIdentity, issuer: "https://attacker.example" },
    ...config,
  }), /identity_link_dual_identity_invalid/);
  await assert.rejects(() => verifyIdentityLinkIdentityPair({
    supabaseToken: tokenFor(),
    cloudflareIdentity: { ...accessIdentity, audience: "other-app" },
    ...config,
  }), /identity_link_dual_identity_invalid/);
});

test("rejects identical identity-provider issuers before attempting Supabase verification", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: tokenFor(),
      cloudflareIdentity: { ...accessIdentity, issuer: SUPABASE_ISSUER },
      ...config,
      accessIssuer: SUPABASE_ISSUER,
    }), /identity_link_dual_identity_invalid/);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects an invalid Supabase token rather than returning a partial identity pair", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: "not-a-valid-jwt-token", cloudflareIdentity: accessIdentity, ...config,
    }), /invalid_supabase_token/);
  } finally { globalThis.fetch = originalFetch; }
});
