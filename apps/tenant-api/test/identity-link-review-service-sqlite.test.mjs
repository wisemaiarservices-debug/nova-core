import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { listPendingIdentityLinkRequests, decideIdentityLinkRequest } from "../src/identity-link-review.mjs";

const migrationDir = new URL("../../api/migrations/", import.meta.url);
const migrations = [
  "0022_tenant_identity_link_challenges.sql",
  "0023_identity_link_distinct_issuers.sql",
  "0024_tenant_identity_link_uniqueness.sql",
  "0025_identity_link_rate_limits.sql",
].map(name => readFileSync(fileURLToPath(new URL(name, migrationDir)), "utf8"));

const tenantId = "tenant-review-sqlite";
const owner = { issuer: "https://team.cloudflareaccess.com", subject: "owner-sqlite" };
const requester = { issuer: owner.issuer, subject: "requester-sqlite" };
const supabaseIssuer = "https://project.supabase.co/auth/v1";
const now = new Date("2026-11-15T12:00:00.000Z");

function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              return { results: sqlite.prepare(sql).all(...args) };
            },
            async run() {
              const result = sqlite.prepare(sql).run(...args);
              return { meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          const result = await statement.run();
          results.push(result);
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  // Minimal tenant prerequisite schema; all identity-link tables, indexes and
  // triggers below are applied from the repository's actual ordered migrations.
  sqlite.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE tenant_memberships (
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      subject TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (tenant_id, subject)
    );
  `);
  for (const migration of migrations) sqlite.exec(migration);

  sqlite.prepare("INSERT INTO tenants (id, status) VALUES (?, 'active')").run(tenantId);
  const addMember = sqlite.prepare(`
    INSERT INTO tenant_memberships (tenant_id, subject, role, status)
    VALUES (?, ?, ?, 'active')
  `);
  addMember.run(tenantId, owner.subject, "tenant_owner");
  addMember.run(tenantId, requester.subject, "operator");

  const createdAt = "2026-11-15T11:55:00.000Z";
  const consumedAt = "2026-11-15T11:56:00.000Z";
  sqlite.prepare(`
    INSERT INTO tenant_identity_link_challenges
      (id, supabase_issuer, supabase_subject, cloudflare_issuer, cloudflare_subject,
       challenge_sha256, status, created_at, expires_at, consumed_at, request_id)
    VALUES (?, ?, ?, ?, ?, ?, 'consumed', ?, ?, ?, ?)
  `).run("challenge-review", supabaseIssuer, "supabase-user", requester.issuer,
    requester.subject, "a".repeat(64), createdAt, "2026-11-15T12:00:00.000Z",
    consumedAt, "challenge-request-review");

  sqlite.prepare(`
    INSERT INTO tenant_identity_link_requests
      (id, challenge_id, supabase_issuer, supabase_subject, cloudflare_issuer,
       cloudflare_subject, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("link-review", "challenge-review", supabaseIssuer, "supabase-user",
    requester.issuer, requester.subject, "link-request-review");

  sqlite.prepare(`
    INSERT INTO tenant_identity_link_events
      (id, link_request_id, event_type, previous_status, new_status, tenant_id,
       actor_cloudflare_issuer, actor_cloudflare_subject, reason, request_id)
    VALUES (?, ?, 'requested', NULL, 'pending', NULL, ?, ?, ?, ?)
  `).run("event-requested-review", "link-review", requester.issuer,
    requester.subject, "independently verified identities presented", "event-request-review");

  return { sqlite, db: d1Adapter(sqlite) };
}

test("real SQLite migrations scope the pending review queue to an active tenant owner and requester membership", async t => {
  const { db, sqlite } = fixture(t);

  const visible = await listPendingIdentityLinkRequests(db, tenantId, owner);
  assert.equal(visible.status, 200);
  assert.equal(visible.data.length, 1);
  assert.equal(visible.data[0].id, "link-review");

  const wrongIssuer = await listPendingIdentityLinkRequests(db, tenantId,
    { issuer: "https://attacker.example", subject: owner.subject });
  assert.equal(wrongIssuer.status, 200);
  assert.equal(wrongIssuer.data.length, 0);

  const nonOwner = await listPendingIdentityLinkRequests(db, tenantId,
    { issuer: owner.issuer, subject: requester.subject });
  assert.equal(nonOwner.status, 404);

  sqlite.prepare("UPDATE tenant_memberships SET status = 'suspended' WHERE tenant_id = ? AND subject = ?")
    .run(tenantId, requester.subject);
  const suspendedRequester = await listPendingIdentityLinkRequests(db, tenantId, owner);
  assert.equal(suspendedRequester.status, 200);
  assert.equal(suspendedRequester.data.length, 0);
});

test("real SQLite migrations enforce owner approval and revocation after requester deactivation", async t => {
  const { db, sqlite } = fixture(t);

  const wrongIssuer = await decideIdentityLinkRequest(db, tenantId, "link-review",
    { issuer: "https://attacker.example", subject: owner.subject },
    "approve", "Independent review completed", "wrong-issuer-decision", now);
  assert.equal(wrongIssuer.status, 409);
  assert.equal(sqlite.prepare("SELECT status FROM tenant_identity_link_requests WHERE id = ?")
    .get("link-review").status, "pending");

  const approved = await decideIdentityLinkRequest(db, tenantId, "link-review", owner,
    "approve", "Independent review completed", "approve-review-decision", now);
  assert.equal(approved.status, 200);
  assert.equal(approved.data.status, "approved");
  assert.equal(sqlite.prepare("SELECT status FROM tenant_identity_link_requests WHERE id = ?")
    .get("link-review").status, "approved");

  // A departed requester must not prevent an owner from revoking the link.
  sqlite.prepare("UPDATE tenant_memberships SET status = 'revoked' WHERE tenant_id = ? AND subject = ?")
    .run(tenantId, requester.subject);
  const revoked = await decideIdentityLinkRequest(db, tenantId, "link-review", owner,
    "revoke", "Requester membership was revoked", "revoke-review-decision",
    new Date("2026-11-15T12:01:00.000Z"));
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.status, "revoked");
  assert.equal(sqlite.prepare("SELECT status FROM tenant_identity_link_requests WHERE id = ?")
    .get("link-review").status, "revoked");

  const events = sqlite.prepare(`
    SELECT event_type, actor_cloudflare_subject FROM tenant_identity_link_events
    WHERE link_request_id = ? ORDER BY created_at, id
  `).all("link-review");
  assert.deepEqual(events.map(event => event.event_type).sort(), ["approved", "requested", "revoked"]);
  assert.ok(events.filter(event => event.event_type !== "requested")
    .every(event => event.actor_cloudflare_subject === owner.subject));
});

test("real SQLite triggers reject cross-tenant owner decisions and preserve append-only audit", async t => {
  const { db, sqlite } = fixture(t);
  sqlite.prepare("INSERT INTO tenants (id, status) VALUES (?, 'active')").run("tenant-other");
  sqlite.prepare(`
    INSERT INTO tenant_memberships (tenant_id, subject, role, status)
    VALUES (?, ?, 'tenant_owner', 'active')
  `).run("tenant-other", owner.subject);

  const denied = await decideIdentityLinkRequest(db, "tenant-other", "link-review", owner,
    "approve", "Wrong tenant", "cross-tenant-decision", now);
  assert.equal(denied.status, 409);
  assert.equal(sqlite.prepare("SELECT status FROM tenant_identity_link_requests WHERE id = ?")
    .get("link-review").status, "pending");

  const approved = await decideIdentityLinkRequest(db, tenantId, "link-review", owner,
    "approve", "Correct tenant", "correct-tenant-decision", now);
  assert.equal(approved.status, 200);
  assert.throws(() => sqlite.prepare(`
    UPDATE tenant_identity_link_events SET reason = 'tampered' WHERE request_id = ?
  `).run("correct-tenant-decision"), /identity-link events are append-only/);
});
