import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { listPendingIdentityLinkRequests, decideIdentityLinkRequest } from "../src/identity-link-review.mjs";
import { createIdentityLinkChallenge, consumeIdentityLinkChallenge } from "../src/identity-link-challenge-service.mjs";

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
  // D1 serializes atomic batches. Queue transactions on this shared SQLite
  // connection while allowing service-level reads to race before each batch.
  let batchTail = Promise.resolve();
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
    batch(statements) {
      const execute = async () => {
        sqlite.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) {
            results.push(await statement.run());
          }
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      };
      const pending = batchTail.then(execute, execute);
      batchTail = pending.then(() => undefined, () => undefined);
      return pending;
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


test("real SQLite migrations allow only one concurrent consume of the same identity-link challenge", async t => {
  const { db, sqlite } = fixture(t);
  const supabaseIdentity = {
    issuer: supabaseIssuer,
    subject: "supabase-concurrent-user",
    audience: "authenticated",
  };
  const cloudflareIdentity = {
    issuer: requester.issuer,
    subject: requester.subject,
    audience: "nova-core",
  };
  const created = await createIdentityLinkChallenge(db, supabaseIdentity,
    cloudflareIdentity, "concurrent-create-request", now);
  assert.equal(created.status, 201);

  const attempts = await Promise.all([
    consumeIdentityLinkChallenge(db, created.data.challenge_id, created.data.challenge,
      supabaseIdentity, cloudflareIdentity, "concurrent-consume-a",
      new Date("2026-11-15T12:00:01.000Z")),
    consumeIdentityLinkChallenge(db, created.data.challenge_id, created.data.challenge,
      supabaseIdentity, cloudflareIdentity, "concurrent-consume-b",
      new Date("2026-11-15T12:00:01.000Z")),
  ]);

  assert.deepEqual(attempts.map(result => result.status).sort(), [201, 409]);
  const challenge = sqlite.prepare(
    "SELECT status, consumed_at FROM tenant_identity_link_challenges WHERE id = ?"
  ).get(created.data.challenge_id);
  assert.equal(challenge.status, "consumed");
  assert.ok(challenge.consumed_at);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM tenant_identity_link_requests WHERE challenge_id = ?"
  ).get(created.data.challenge_id).count, 1);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM tenant_identity_link_events e JOIN tenant_identity_link_requests r ON r.id = e.link_request_id WHERE r.challenge_id = ? AND e.event_type = 'requested'"
  ).get(created.data.challenge_id).count, 1);
});


test("real SQLite migrations make concurrent identical owner decisions idempotent", async t => {
  const { db, sqlite } = fixture(t);
  const decisions = await Promise.all([
    decideIdentityLinkRequest(db, tenantId, "link-review", owner,
      "approve", "Concurrent independent review", "same-owner-decision-key", now),
    decideIdentityLinkRequest(db, tenantId, "link-review", owner,
      "approve", "Concurrent independent review", "same-owner-decision-key", now),
  ]);

  assert.deepEqual(decisions.map(result => result.status), [200, 200]);
  assert.ok(decisions.every(result => result.data.status === "approved"));
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM tenant_identity_link_events WHERE request_id = ?"
  ).get("same-owner-decision-key").count, 1);
  assert.equal(sqlite.prepare(
    "SELECT status FROM tenant_identity_link_requests WHERE id = ?"
  ).get("link-review").status, "approved");
});

test("real SQLite migrations allow only one of two concurrent conflicting owner decisions", async t => {
  const { db, sqlite } = fixture(t);
  const decisions = await Promise.all([
    decideIdentityLinkRequest(db, tenantId, "link-review", owner,
      "approve", "Approve after review", "competing-approve-key", now),
    decideIdentityLinkRequest(db, tenantId, "link-review", owner,
      "reject", "Reject after review", "competing-reject-key", now),
  ]);

  assert.deepEqual(decisions.map(result => result.status).sort(), [200, 409]);
  const request = sqlite.prepare(
    "SELECT status FROM tenant_identity_link_requests WHERE id = ?"
  ).get("link-review");
  assert.ok(["approved", "rejected"].includes(request.status));
  const decisionEvents = sqlite.prepare(
    "SELECT event_type, request_id FROM tenant_identity_link_events WHERE link_request_id = ? AND event_type IN ('approved', 'rejected')"
  ).all("link-review");
  assert.equal(decisionEvents.length, 1);
  assert.equal(decisionEvents[0].event_type, request.status);
});


test("real SQLite active mapping indexes block ambiguous approved identities and roll back owner event", async t => {
  const { db, sqlite } = fixture(t);
  const otherRequester = { issuer: requester.issuer, subject: "other-requester-sqlite", audience: "nova-core" };
  sqlite.prepare("INSERT INTO tenant_memberships (tenant_id, subject, role, status) VALUES (?, ?, 'operator', 'active')")
    .run(tenantId, otherRequester.subject);

  const first = await decideIdentityLinkRequest(db, tenantId, "link-review", owner,
    "approve", "Approve first mapping", "approve-first-mapping", now);
  assert.equal(first.status, 200);

  const supabaseIdentity = { issuer: supabaseIssuer, subject: "supabase-user", audience: "authenticated" };
  const secondChallenge = await createIdentityLinkChallenge(db, supabaseIdentity,
    otherRequester, "create-second-mapping", now);
  assert.equal(secondChallenge.status, 201);
  const secondRequest = await consumeIdentityLinkChallenge(db, secondChallenge.data.challenge_id,
    secondChallenge.data.challenge, supabaseIdentity, otherRequester,
    "consume-second-mapping", new Date("2026-11-15T12:00:01.000Z"));
  assert.equal(secondRequest.status, 201);

  await assert.rejects(() => decideIdentityLinkRequest(db, tenantId,
    secondRequest.data.link_request_id, owner, "approve", "Attempt duplicate mapping",
    "approve-second-mapping", new Date("2026-11-15T12:00:02.000Z")),
  /UNIQUE constraint failed/);
  assert.equal(sqlite.prepare("SELECT status FROM tenant_identity_link_requests WHERE id = ?")
    .get(secondRequest.data.link_request_id).status, "pending");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM tenant_identity_link_events WHERE request_id = ?")
    .get("approve-second-mapping").count, 0);
});

test("real SQLite permits a new independently reviewed link after owner revocation", async t => {
  const { db, sqlite } = fixture(t);
  const supabaseIdentity = { issuer: supabaseIssuer, subject: "supabase-user", audience: "authenticated" };
  const cloudflareIdentity = { ...requester, audience: "nova-core" };

  const approved = await decideIdentityLinkRequest(db, tenantId, "link-review", owner,
    "approve", "Approve original mapping", "approve-original-mapping", now);
  assert.equal(approved.status, 200);
  const revoked = await decideIdentityLinkRequest(db, tenantId, "link-review", owner,
    "revoke", "Revoke original mapping", "revoke-original-mapping",
    new Date("2026-11-15T12:00:01.000Z"));
  assert.equal(revoked.status, 200);

  const nextChallenge = await createIdentityLinkChallenge(db, supabaseIdentity,
    cloudflareIdentity, "create-relink-challenge", new Date("2026-11-15T12:00:02.000Z"));
  assert.equal(nextChallenge.status, 201);
  const nextRequest = await consumeIdentityLinkChallenge(db, nextChallenge.data.challenge_id,
    nextChallenge.data.challenge, supabaseIdentity, cloudflareIdentity, "consume-relink-challenge",
    new Date("2026-11-15T12:00:03.000Z"));
  assert.equal(nextRequest.status, 201);
  const reapproved = await decideIdentityLinkRequest(db, tenantId,
    nextRequest.data.link_request_id, owner, "approve", "Approve reviewed relink",
    "approve-reviewed-relink", new Date("2026-11-15T12:00:04.000Z"));
  assert.equal(reapproved.status, 200);

  assert.deepEqual(sqlite.prepare(
    "SELECT status FROM tenant_identity_link_requests WHERE supabase_issuer = ? AND supabase_subject = ? AND cloudflare_issuer = ? AND cloudflare_subject = ? ORDER BY created_at, id"
  ).all(supabaseIssuer, "supabase-user", requester.issuer, requester.subject).map(row => row.status),
  ["revoked", "approved"]);
});


test("real SQLite active mapping indexes also block a second Supabase identity for one Cloudflare identity", async t => {
  const { db, sqlite } = fixture(t);
  const first = await decideIdentityLinkRequest(db, tenantId, "link-review", owner,
    "approve", "Approve original mapping", "approve-original-cloudflare-mapping", now);
  assert.equal(first.status, 200);

  const otherSupabase = { issuer: supabaseIssuer, subject: "other-supabase-identity", audience: "authenticated" };
  const cloudflareIdentity = { ...requester, audience: "nova-core" };
  const challenge = await createIdentityLinkChallenge(db, otherSupabase, cloudflareIdentity,
    "create-second-supabase-mapping", new Date("2026-11-15T12:00:01.000Z"));
  assert.equal(challenge.status, 201);
  const request = await consumeIdentityLinkChallenge(db, challenge.data.challenge_id,
    challenge.data.challenge, otherSupabase, cloudflareIdentity,
    "consume-second-supabase-mapping", new Date("2026-11-15T12:00:02.000Z"));
  assert.equal(request.status, 201);

  await assert.rejects(() => decideIdentityLinkRequest(db, tenantId,
    request.data.link_request_id, owner, "approve", "Attempt second Supabase mapping",
    "approve-second-supabase-mapping", new Date("2026-11-15T12:00:03.000Z")),
  /UNIQUE constraint failed/);
  assert.equal(sqlite.prepare("SELECT status FROM tenant_identity_link_requests WHERE id = ?")
    .get(request.data.link_request_id).status, "pending");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM tenant_identity_link_events WHERE request_id = ?")
    .get("approve-second-supabase-mapping").count, 0);
});

test("real SQLite allows the same identity pair to be independently approved in separate tenants", async t => {
  const { db, sqlite } = fixture(t);
  const supabaseIdentity = { issuer: supabaseIssuer, subject: "supabase-user", audience: "authenticated" };
  const cloudflareIdentity = { ...requester, audience: "nova-core" };
  const first = await decideIdentityLinkRequest(db, tenantId, "link-review", owner,
    "approve", "Approve in first tenant", "approve-pair-first-tenant", now);
  assert.equal(first.status, 200);

  sqlite.prepare("INSERT INTO tenants (id, status) VALUES (?, 'active')").run("tenant-independent");
  const addMember = sqlite.prepare(`
    INSERT INTO tenant_memberships (tenant_id, subject, role, status)
    VALUES (?, ?, ?, 'active')
  `);
  addMember.run("tenant-independent", owner.subject, "tenant_owner");
  addMember.run("tenant-independent", requester.subject, "operator");

  const challenge = await createIdentityLinkChallenge(db, supabaseIdentity, cloudflareIdentity,
    "create-pair-second-tenant", new Date("2026-11-15T12:00:01.000Z"));
  assert.equal(challenge.status, 201);
  const request = await consumeIdentityLinkChallenge(db, challenge.data.challenge_id,
    challenge.data.challenge, supabaseIdentity, cloudflareIdentity,
    "consume-pair-second-tenant", new Date("2026-11-15T12:00:02.000Z"));
  assert.equal(request.status, 201);
  const second = await decideIdentityLinkRequest(db, "tenant-independent",
    request.data.link_request_id, owner, "approve", "Approve independently in second tenant",
    "approve-pair-second-tenant", new Date("2026-11-15T12:00:03.000Z"));
  assert.equal(second.status, 200);
  assert.deepEqual(sqlite.prepare(`
    SELECT tenant_id, status FROM tenant_identity_link_requests
    WHERE supabase_issuer = ? AND supabase_subject = ?
      AND cloudflare_issuer = ? AND cloudflare_subject = ?
    ORDER BY tenant_id
  `).all(supabaseIssuer, "supabase-user", requester.issuer, requester.subject)
    .map(row => ({ tenant_id: row.tenant_id, status: row.status })),
  [{ tenant_id: "tenant-independent", status: "approved" }, { tenant_id: tenantId, status: "approved" }]);
});
