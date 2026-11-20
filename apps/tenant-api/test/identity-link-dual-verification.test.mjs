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


function signedToken(claimOverrides = {}, signingKey = privateKey, keyId = jwk.kid) {
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }));
  const claims = b64(JSON.stringify({
    iss: SUPABASE_ISSUER, aud: SUPABASE_AUDIENCE, sub: "supabase-user",
    role: "authenticated", iat: now - 5, exp: now + 300, ...claimOverrides,
  }));
  const input = header + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), signingKey).toString("base64url");
}

async function withJwks(document, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), SUPABASE_ISSUER + "/.well-known/jwks.json");
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify(document), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try { return await callback(); }
  finally { globalThis.fetch = originalFetch; }
}

test("fails closed for expired, future-issued, wrong-issuer, wrong-audience and wrong-role Supabase JWTs", async () => {
  const invalidClaims = [
    [{ exp: now - 120 }, /supabase_token_expired/],
    [{ iat: now + 120 }, /supabase_token_issue_time_invalid/],
    [{ iss: "https://attacker.example/auth/v1" }, /unexpected_supabase_issuer/],
    [{ aud: "other-audience" }, /unexpected_supabase_audience/],
    [{ role: "anon" }, /supabase_authenticated_role_required/],
  ];
  await withJwks({ keys: [jwk] }, async () => {
    for (const [claims, expected] of invalidClaims) {
      await assert.rejects(() => verifyIdentityLinkIdentityPair({
        supabaseToken: signedToken(claims), cloudflareIdentity: accessIdentity, ...config,
      }), expected);
    }
  });
});

test("rejects a JWT signed by a different private key even when the configured JWKS is valid", async () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await withJwks({ keys: [jwk] }, async () => {
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: signedToken({}, other.privateKey), cloudflareIdentity: accessIdentity, ...config,
    }), /supabase_signature_invalid/);
  });
});

test("fails closed when the signing key id is absent from the configured JWKS", async () => {
  await withJwks({ keys: [jwk] }, async () => {
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: signedToken({}, privateKey, "unknown-key-id"),
      cloudflareIdentity: accessIdentity, ...config,
    }), /supabase_signing_key_not_found/);
  });
});

test("rejects duplicate JWKS key ids before selecting a signing key", async () => {
  await withJwks({ keys: [jwk, jwk] }, async () => {
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: tokenFor(), cloudflareIdentity: accessIdentity, ...config,
    }), /supabase_jwks_invalid/);
  });
});

test("fails closed when the Supabase JWKS endpoint is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("synthetic network failure"); };
  try {
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: tokenFor(), cloudflareIdentity: accessIdentity, ...config,
    }), /supabase_jwks_unavailable/);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects invalid issuer configuration before making a JWKS request", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  try {
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: tokenFor(), cloudflareIdentity: accessIdentity, ...config,
      supabaseIssuer: "http://project.example.test/auth/v1",
    }), /invalid_supabase_issuer_configuration/);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = originalFetch; }
});


test("rejects not-before claims that are future-dated or malformed", async () => {
  await withJwks({ keys: [jwk] }, async () => {
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: signedToken({ nbf: now + 120 }),
      cloudflareIdentity: accessIdentity, ...config,
    }), /supabase_token_not_yet_valid/);
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: signedToken({ nbf: "tomorrow" }),
      cloudflareIdentity: accessIdentity, ...config,
    }), /supabase_token_not_yet_valid/);
  });
});

test("rejects unsupported JWT algorithms before fetching JWKS", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT", kid: jwk.kid }));
  const claims = b64(JSON.stringify({ iss: SUPABASE_ISSUER, aud: SUPABASE_AUDIENCE,
    sub: "supabase-user", role: "authenticated", iat: now - 5, exp: now + 300 }));
  try {
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: header + "." + claims + ".signature",
      cloudflareIdentity: accessIdentity, ...config,
    }), /unsupported_supabase_token_algorithm/);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects malformed and oversized JWKS responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("{not-json", {
      status: 200, headers: { "content-type": "application/json" },
    });
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: tokenFor(), cloudflareIdentity: accessIdentity, ...config,
    }), /supabase_jwks_invalid/);

    globalThis.fetch = async () => new Response("{}", {
      status: 200, headers: { "content-type": "application/json", "content-length": "70000" },
    });
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: tokenFor(), cloudflareIdentity: accessIdentity, ...config,
    }), /supabase_jwks_invalid/);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects JWKS entries that do not advertise an acceptable RSA signing key", async () => {
  const invalid = { ...jwk, use: "enc" };
  await withJwks({ keys: [invalid] }, async () => {
    await assert.rejects(() => verifyIdentityLinkIdentityPair({
      supabaseToken: tokenFor(), cloudflareIdentity: accessIdentity, ...config,
    }), /supabase_signing_key_not_found/);
  });
});
