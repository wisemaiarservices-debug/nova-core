import test from "node:test";
import assert from "node:assert/strict";
import { createIdentityLinkChallenge, consumeIdentityLinkChallenge } from "../src/identity-link-challenge-service.mjs";

const supabase = { issuer: "https://project.supabase.co/auth/v1", subject: "supabase-user-1", audience: "authenticated" };
const access = { issuer: "https://team.cloudflareaccess.com", subject: "access-user-1", audience: "nova-core" };

class ChallengeDB {
  constructor() { this.row = null; this.batchCalls = []; }
  prepare(sql) {
    return { sql, args: [], bind(...args) { this.args = args; return this; },
      async run() {
        if (this.sql.startsWith("INSERT INTO tenant_identity_link_challenges")) {
          if (this.row) return { meta: { changes: 0 } };
          const [id, si, ss, ci, cs, digest, created, expires, request] = this.args;
          this.row = { id, supabase_issuer: si, supabase_subject: ss, cloudflare_issuer: ci,
            cloudflare_subject: cs, challenge_sha256: digest, status: "pending",
            created_at: created, expires_at: expires, request_id: request };
          return { meta: { changes: 1 } };
        }
        throw new Error("unexpected run");
      },
      async all() {
        if (!this.row || this.row.id !== this.args[0] || this.row.challenge_sha256 !== this.args[1])
          return { results: [] };
        return { results: [this.row] };
      },
    };
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    if (this.row.status !== "pending") return statements.map(() => ({ meta: { changes: 0 } }));
    this.row.status = "consumed";
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

test("challenge is random, short-lived and stores no raw challenge", async () => {
  const db = new ChallengeDB();
  const now = new Date("2026-11-14T10:00:00.000Z");
  const result = await createIdentityLinkChallenge(db, supabase, access, "request-1", now);
  assert.equal(result.status, 201);
  assert.equal(result.data.challenge.length, 43);
  assert.equal(result.data.expires_at, "2026-11-14T10:05:00.000Z");
  assert.notEqual(db.row.challenge_sha256, result.data.challenge);
  assert.equal(JSON.stringify(db.row).includes(result.data.challenge), false);
});

test("challenge creation rejects missing verified identity fields", async () => {
  const db = new ChallengeDB();
  const result = await createIdentityLinkChallenge(db, { subject: "unverified" }, access, "request-2");
  assert.equal(result.status, 400);
  assert.equal(db.row, null);
});

test("consumption requires exact identities and writes an atomic pending request", async () => {
  const db = new ChallengeDB();
  const now = new Date("2026-11-14T10:00:00.000Z");
  const created = await createIdentityLinkChallenge(db, supabase, access, "request-3", now);
  const wrong = await consumeIdentityLinkChallenge(db, created.data.challenge_id,
    created.data.challenge, { ...supabase, subject: "other-user" }, access, "consume-1", now);
  assert.equal(wrong.status, 409);
  assert.equal(db.batchCalls.length, 0);
  const consumed = await consumeIdentityLinkChallenge(db, created.data.challenge_id,
    created.data.challenge, supabase, access, "consume-2", now);
  assert.equal(consumed.status, 201);
  assert.equal(consumed.data.status, "pending");
  assert.equal(db.batchCalls[0].length, 3);
  assert.match(db.batchCalls[0][0].sql, /status = 'pending' AND expires_at >/);
  assert.match(db.batchCalls[0][1].sql, /WHERE changes\(\) = 1/);
  assert.match(db.batchCalls[0][2].sql, /WHERE changes\(\) = 1/);
});

test("expired challenges cannot be consumed", async () => {
  const db = new ChallengeDB();
  const createdAt = new Date("2026-11-14T10:00:00.000Z");
  const created = await createIdentityLinkChallenge(db, supabase, access, "request-4", createdAt);
  const result = await consumeIdentityLinkChallenge(db, created.data.challenge_id,
    created.data.challenge, supabase, access, "consume-4", new Date("2026-11-14T10:05:00.000Z"));
  assert.equal(result.status, 409);
  assert.equal(db.batchCalls.length, 0);
});

test("challenge consumption rejects malformed challenge material", async () => {
  const result = await consumeIdentityLinkChallenge(new ChallengeDB(), "bad/id", "short",
    supabase, access, "consume-5");
  assert.equal(result.status, 400);
});
