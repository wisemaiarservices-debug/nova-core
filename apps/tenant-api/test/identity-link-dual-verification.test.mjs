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


class PersistedChallengeDb {
  constructor() { this.row = null; this.batchCalls = []; }
  prepare(sql) {
    const db = this;
    return {
      sql, args: [],
      bind(...args) { this.args = args; return this; },
      async run() {
        if (this.sql.startsWith("INSERT INTO tenant_identity_link_challenges")) {
          if (db.row) return { meta: { changes: 0 } };
          const [id, si, ss, ci, cs, digest, created, expires, request] = this.args;
          db.row = { id, supabase_issuer: si, supabase_subject: ss,
            cloudflare_issuer: ci, cloudflare_subject: cs,
            challenge_sha256: digest, status: "pending", created_at: created,
            expires_at: expires, request_id: request };
          return { meta: { changes: 1 } };
        }
        throw new Error("unexpected run SQL: " + this.sql);
      },
      async all() {
        if (!db.row || db.row.id !== this.args[0] ||
            db.row.challenge_sha256 !== this.args[1]) return { results: [] };
        return { results: [db.row] };
      },
    };
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    if (!this.row || this.row.status !== "pending") {
      return statements.map(() => ({ meta: { changes: 0 } }));
    }
    this.row.status = "consumed";
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

test("verified challenge orchestration verifies both identities before create and atomic consume", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  try {
    const db = new PersistedChallengeDb();
    const createdAt = new Date("2026-11-14T10:00:00.000Z");
    const created = await import("../src/identity-link-dual-verification.mjs")
      .then(({ createVerifiedIdentityLinkChallenge }) =>
        createVerifiedIdentityLinkChallenge(db, {
          supabaseToken: tokenFor(), cloudflareIdentity: accessIdentity, ...config,
          requestId: "verified-create-1", now: createdAt,
        }));
    assert.equal(created.status, 201);
    assert.equal(db.row.supabase_issuer, SUPABASE_ISSUER);
    assert.equal(db.row.supabase_subject, "supabase-user");
    assert.equal(db.row.cloudflare_issuer, ACCESS_ISSUER);
    assert.equal(db.row.cloudflare_subject, "cloudflare-access-user");
    assert.equal(db.row.status, "pending");

    const { consumeVerifiedIdentityLinkChallenge } =
      await import("../src/identity-link-dual-verification.mjs");
    const consumed = await consumeVerifiedIdentityLinkChallenge(db, {
      challengeId: created.data.challenge_id, challenge: created.data.challenge,
      supabaseToken: tokenFor(), cloudflareIdentity: accessIdentity, ...config,
      requestId: "verified-consume-1", now: createdAt,
    });
    assert.equal(consumed.status, 201);
    assert.equal(consumed.data.status, "pending");
    assert.equal(db.row.status, "consumed");
    assert.equal(db.batchCalls.length, 1);
    assert.equal(db.batchCalls[0].length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("verified challenge orchestration never persists a pair with a shared issuer", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("JWKS must not be fetched"); };
  try {
    const db = new PersistedChallengeDb();
    await assert.rejects(() => import("../src/identity-link-dual-verification.mjs")
      .then(({ createVerifiedIdentityLinkChallenge }) =>
        createVerifiedIdentityLinkChallenge(db, {
          supabaseToken: tokenFor(),
          cloudflareIdentity: { ...accessIdentity, issuer: SUPABASE_ISSUER },
          ...config, accessIssuer: SUPABASE_ISSUER,
          requestId: "verified-create-same-issuer",
        })), /identity_link_dual_identity_invalid/);
    assert.equal(db.row, null);
  } finally { globalThis.fetch = originalFetch; }
});


test("reuses verified Supabase claims without a second JWKS fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("duplicate JWKS fetch"); };
  try {
    const pair = await verifyIdentityLinkIdentityPair({
      supabaseToken: tokenFor(),
      verifiedSupabaseIdentity: {
        issuer: SUPABASE_ISSUER,
        subject: "supabase-user",
        audience: SUPABASE_AUDIENCE,
      },
      cloudflareIdentity: accessIdentity,
      ...config,
    });
    assert.equal(pair.supabase.subject, "supabase-user");
    assert.equal(fetched, false);
  } finally { globalThis.fetch = originalFetch; }
});
