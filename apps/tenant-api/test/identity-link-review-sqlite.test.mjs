import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const migrationPath = fileURLToPath(new URL("../../api/migrations/0022_tenant_identity_link_challenges.sql", import.meta.url));
const migration = readFileSync(migrationPath, "utf8");
const requester = {
  issuer: "https://team.cloudflareaccess.com",
  subject: "linked-user",
};
const owner = {
  issuer: requester.issuer,
  subject: "tenant-owner",
};
const tenantId = "tenant-sqlite-test";
const now = "2026-11-14T20:00:00.000Z";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  // Minimal prerequisite schema for the exact tenant columns referenced by
  // migration 0022. The identity-link tables and triggers are the real SQL.
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE tenant_memberships (
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      subject TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (tenant_id, subject)
    );
  `);
  db.exec(migration);
  db.prepare("INSERT INTO tenants (id, status) VALUES (?, 'active')").run(tenantId);
  db.prepare(`INSERT INTO tenant_memberships (tenant_id, subject, role, status)
    VALUES (?, ?, 'tenant_owner', 'active')`).run(tenantId, owner.subject);

  db.prepare(`INSERT INTO tenant_identity_link_challenges
    (id, supabase_issuer, supabase_subject, cloudflare_issuer, cloudflare_subject,
     challenge_sha256, status, created_at, expires_at, consumed_at, request_id)
    VALUES (?, ?, ?, ?, ?, ?, 'consumed', ?, ?, ?, ?)`).run(
      "challenge-1", "https://project.supabase.co/auth/v1", "supabase-user",
      requester.issuer, requester.subject, "a".repeat(64), now,
      "2026-11-14T20:05:00.000Z", "2026-11-14T20:01:00.000Z", "challenge-request-1"
    );
  db.prepare(`INSERT INTO tenant_identity_link_requests
    (id, challenge_id, supabase_issuer, supabase_subject, cloudflare_issuer,
     cloudflare_subject, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "link-request-1", "challenge-1", "https://project.supabase.co/auth/v1",
      "supabase-user", requester.issuer, requester.subject, "link-request-1"
    );
  return db;
}

function insertEvent(db, {
  id, eventType, previousStatus, newStatus, tenant = tenantId,
  actor = owner, reason = "SQLite trigger integration test", requestId = id,
}) {
  db.prepare(`INSERT INTO tenant_identity_link_events
    (id, link_request_id, event_type, previous_status, new_status, tenant_id,
     actor_cloudflare_issuer, actor_cloudflare_subject, reason, request_id)
    VALUES (?, 'link-request-1', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, eventType, previousStatus, newStatus, tenant,
      actor.issuer, actor.subject, reason, requestId
    );
}

function approve(db) {
  insertEvent(db, {
    id: "event-approved", eventType: "approved",
    previousStatus: "pending", newStatus: "approved",
  });
  db.prepare(`UPDATE tenant_identity_link_requests SET status = 'approved',
    tenant_id = ?, decided_by_cloudflare_issuer = ?, decided_by_cloudflare_subject = ?,
    reason = ?, decided_at = ? WHERE id = 'link-request-1'`).run(
      tenantId, owner.issuer, owner.subject, "Owner approved after review", now
    );
}

test("SQLite trigger rejects a requested event with a forged Cloudflare issuer", (t) => {
  const db = fixture(t);
  assert.throws(() => insertEvent(db, {
    id: "event-requested-forged", eventType: "requested",
    previousStatus: null, newStatus: "pending",
    actor: { issuer: "https://attacker.cloudflareaccess.com", subject: requester.subject },
    tenant: null,
  }), /identity-link event does not match request pre-state or owner authority/);
});

test("SQLite trigger rejects approval and revocation events with a forged issuer", (t) => {
  const db = fixture(t);

  assert.throws(() => insertEvent(db, {
    id: "event-approved-forged", eventType: "approved",
    previousStatus: "pending", newStatus: "approved",
    actor: { issuer: "https://attacker.cloudflareaccess.com", subject: owner.subject },
  }), /identity-link event does not match request pre-state or owner authority/);

  approve(db);
  assert.equal(db.prepare("SELECT status FROM tenant_identity_link_requests WHERE id = ?")
    .get("link-request-1").status, "approved");

  assert.throws(() => insertEvent(db, {
    id: "event-revoked-forged", eventType: "revoked",
    previousStatus: "approved", newStatus: "revoked",
    actor: { issuer: "https://attacker.cloudflareaccess.com", subject: owner.subject },
  }), /identity-link event does not match request pre-state or owner authority/);

  insertEvent(db, {
    id: "event-revoked", eventType: "revoked",
    previousStatus: "approved", newStatus: "revoked",
  });
  db.prepare(`UPDATE tenant_identity_link_requests SET status = 'revoked',
    decided_by_cloudflare_issuer = ?, decided_by_cloudflare_subject = ?,
    reason = ?, decided_at = ? WHERE id = 'link-request-1'`).run(
      owner.issuer, owner.subject, "Owner revoked after review", "2026-11-14T20:02:00.000Z"
    );
  assert.equal(db.prepare("SELECT status FROM tenant_identity_link_requests WHERE id = ?")
    .get("link-request-1").status, "revoked");
});

test("SQLite trigger blocks direct request status changes and event mutation", (t) => {
  const db = fixture(t);
  assert.throws(() => db.prepare(`UPDATE tenant_identity_link_requests
    SET status = 'approved', tenant_id = ?, decided_by_cloudflare_issuer = ?,
      decided_by_cloudflare_subject = ?, reason = ?, decided_at = ?
    WHERE id = 'link-request-1'`).run(
      tenantId, owner.issuer, owner.subject, "No matching event", now
    ), /identity-link request update requires matching immutable owner event/);

  insertEvent(db, { id: "event-requested", eventType: "requested", previousStatus: null, newStatus: "pending", actor: requester, tenant: null });
  assert.throws(() => db.prepare(`UPDATE tenant_identity_link_events SET reason = 'tampered'
    WHERE id = ?`).run("event-requested"), /identity-link events are append-only/);
});
