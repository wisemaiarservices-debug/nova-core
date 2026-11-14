import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { consumeIdentityLinkRateLimit } from "../src/identity-link-rate-limit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(here, "../../api/migrations/0025_identity_link_rate_limits.sql"), "utf8");

function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  return {
    sqlite,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            sql, args,
            run() {
              const result = sqlite.prepare(sql).run(...args);
              return { meta: { changes: Number(result.changes) } };
            },
            all() { return { results: sqlite.prepare(sql).all(...args) }; },
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(statement =>
          statement.sql.trimStart().startsWith("DELETE")
            ? statement.run()
            : statement.all()
        );
        sqlite.exec("COMMIT");
        return results;
      } catch (cause) {
        sqlite.exec("ROLLBACK");
        throw cause;
      }
    },
  };
}

const supabase = { issuer: "https://project.example.test/auth/v1", subject: "supabase-subject" };
const cloudflare = { issuer: "https://team.cloudflareaccess.com", subject: "cloudflare-subject" };

test("challenge creation is capped at five requests per verified identity per 15-minute window", async () => {
  const db = sqliteD1();
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await consumeIdentityLinkRateLimit(db, [supabase, cloudflare],
        "challenge_create", 1_800_000_000);
      assert.equal(result.allowed, true);
      assert.equal(result.limit, 5);
    }
    const blocked = await consumeIdentityLinkRateLimit(db, [supabase, cloudflare],
      "challenge_create", 1_800_000_001);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 899);
    const repeated = await consumeIdentityLinkRateLimit(db, [supabase, cloudflare],
      "challenge_create", 1_800_000_002);
    assert.equal(repeated.allowed, false, "repeated blocked requests stay rejected without unbounded counters");
    assert.equal(db.sqlite.prepare("SELECT MAX(request_count) AS count FROM tenant_identity_link_rate_limits").get().count, 6);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM tenant_identity_link_rate_limits").get().count, 2);
  } finally { db.sqlite.close(); }
});

test("challenge consumption has a separate ten-attempt cap and window rollover resets counts", async () => {
  const db = sqliteD1();
  try {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const result = await consumeIdentityLinkRateLimit(db, [supabase, cloudflare],
        "challenge_consume", 1_800_000_000);
      assert.equal(result.allowed, true);
    }
    const blocked = await consumeIdentityLinkRateLimit(db, [supabase, cloudflare],
      "challenge_consume", 1_800_000_001);
    assert.equal(blocked.allowed, false);
    const nextWindow = await consumeIdentityLinkRateLimit(db, [supabase, cloudflare],
      "challenge_consume", 1_800_000_900);
    assert.equal(nextWindow.allowed, true);
    const create = await consumeIdentityLinkRateLimit(db, [supabase, cloudflare],
      "challenge_create", 1_800_000_900);
    assert.equal(create.allowed, true);
  } finally { db.sqlite.close(); }
});

test("rate-limit storage contains only identity digests and prunes expired windows", async () => {
  const db = sqliteD1();
  try {
    await consumeIdentityLinkRateLimit(db, [supabase, cloudflare],
      "challenge_create", 1_800_000_000);
    const rows = db.sqlite.prepare("SELECT identity_digest, operation FROM tenant_identity_link_rate_limits").all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.identity_digest)));
    const stored = JSON.stringify(rows);
    assert.equal(stored.includes(supabase.subject), false);
    assert.equal(stored.includes(cloudflare.subject), false);
    await consumeIdentityLinkRateLimit(db, [supabase, cloudflare],
      "challenge_create", 1_800_100_000);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM tenant_identity_link_rate_limits").get().count, 2);
  } finally { db.sqlite.close(); }
});

test("rate limiter rejects malformed or duplicate identity inputs", async () => {
  const db = sqliteD1();
  try {
    await assert.rejects(() => consumeIdentityLinkRateLimit(db, [supabase, supabase],
      "challenge_create", 1_800_000_000), /must_be_distinct/);
    await assert.rejects(() => consumeIdentityLinkRateLimit(db, [supabase, cloudflare],
      "unknown", 1_800_000_000), /invalid_rate_limit_input/);
  } finally { db.sqlite.close(); }
});
