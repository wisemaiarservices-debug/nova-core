import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { listPendingIdentityLinkRequests, decideIdentityLinkRequest } from "../src/identity-link-review.mjs";

const actor = { issuer: "https://team.cloudflareaccess.com", subject: "owner-1" };
class DB {
  constructor(request = { id: "link-1", status: "pending", tenant_id: null }, owner = true) {
    this.request = request; this.owner = owner; this.batchCalls = []; this.priorEvent = null; this.batchError = null; this.queries = [];
  }
  prepare(sql) {
    this.queries.push(sql);
    const db = this;
    return { sql, args: [], bind(...args) { this.args = args; return this; },
      async all() {
        if (this.sql.includes("FROM tenant_identity_link_events WHERE request_id")) {
          return { results: db.priorEvent ? [db.priorEvent] : [] };
        }
        if (this.sql.includes("FROM tenant_memberships m JOIN tenants")) {
          return { results: db.owner ? [{ subject: this.args[1] }] : [] };
        }
        if (this.sql.includes("FROM tenant_identity_link_requests WHERE id")) {
          return { results: db.request ? [db.request] : [] };
        }
        if (this.sql.includes("WHERE status = 'pending' ORDER BY")) return { results: [] };
        return { results: [] };
      }
    };
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    if (this.batchError) throw this.batchError;
    return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
  }
}

test("pending requests are visible only to active tenant owners", async () => {
  const denied = await listPendingIdentityLinkRequests(new DB(undefined, false), "tenant-1", actor);
  assert.equal(denied.status, 404);
  const allowed = await listPendingIdentityLinkRequests(new DB(), "tenant-1", actor);
  assert.equal(allowed.status, 200);
});
test("approval records owner event and guarded update atomically", async () => {
  const db = new DB();
  const result = await decideIdentityLinkRequest(db, "tenant-1", "link-1", actor,
    "approve", "Reviewed independently", "decision-1", new Date("2026-11-14T12:00:00Z"));
  assert.equal(result.status, 200);
  assert.equal(result.data.status, "approved");
  assert.equal(db.batchCalls[0].length, 2);
  assert.match(db.batchCalls[0][0].sql, /tenant_owner/);
  assert.match(db.batchCalls[0][1].sql, /changes\(\) = 1/);
});
test("rejection requires a reason and pending state", async () => {
  const db = new DB();
  assert.equal((await decideIdentityLinkRequest(db, "tenant-1", "link-1", actor,
    "reject", "", "decision-2")).status, 400);
  db.request.status = "approved";
  assert.equal((await decideIdentityLinkRequest(db, "tenant-1", "link-1", actor,
    "reject", "Not sufficient", "decision-3")).status, 409);
});
test("revocation only applies to an approved link in the same tenant", async () => {
  const db = new DB({ id: "link-1", status: "approved", tenant_id: "tenant-1" });
  const result = await decideIdentityLinkRequest(db, "tenant-1", "link-1", actor,
    "revoke", "Access no longer authorized", "decision-4");
  assert.equal(result.status, 200);
  assert.equal(result.data.status, "revoked");
  const otherTenant = new DB({ id: "link-1", status: "approved", tenant_id: "tenant-2" });
  assert.equal((await decideIdentityLinkRequest(otherTenant, "tenant-1", "link-1", actor,
    "revoke", "Wrong tenant", "decision-5")).status, 409);
});

test("repeated identical owner decision returns the original outcome without another write", async () => {
  const db = new DB({ id: "link-1", status: "approved", tenant_id: "tenant-1" });
  db.priorEvent = {
    link_request_id: "link-1", event_type: "approved", tenant_id: "tenant-1",
    actor_cloudflare_issuer: actor.issuer, actor_cloudflare_subject: actor.subject,
    reason: "Reviewed independently", created_at: "2026-11-14T12:00:00.000Z",
  };
  const result = await decideIdentityLinkRequest(db, "tenant-1", "link-1", actor,
    "approve", "Reviewed independently", "decision-1", new Date("2026-11-14T12:01:00Z"));
  assert.equal(result.status, 200);
  assert.equal(result.data.status, "approved");
  assert.equal(result.data.decided_at, "2026-11-14T12:00:00.000Z");
  assert.equal(db.batchCalls.length, 0);
});

test("idempotency key reuse with different decision content is rejected", async () => {
  const db = new DB();
  db.priorEvent = {
    link_request_id: "another-link", event_type: "approved", tenant_id: "tenant-1",
    actor_cloudflare_issuer: actor.issuer, actor_cloudflare_subject: actor.subject,
    reason: "Reviewed independently", created_at: "2026-11-14T12:00:00.000Z",
  };
  const result = await decideIdentityLinkRequest(db, "tenant-1", "link-1", actor,
    "approve", "Reviewed independently", "decision-1");
  assert.equal(result.status, 409);
  assert.equal(result.error, "identity_link_idempotency_conflict");
  assert.equal(db.batchCalls.length, 0);
});

test("database failures are not disguised as idempotency conflicts", async () => {
  const db = new DB();
  db.batchError = new Error("temporary D1 failure");
  await assert.rejects(
    decideIdentityLinkRequest(db, "tenant-1", "link-1", actor,
      "approve", "Reviewed independently", "decision-db-error"),
    /temporary D1 failure/,
  );
});


test("owner review is independent and bound to the request Cloudflare issuer", async () => {
  const db = new DB();
  const result = await decideIdentityLinkRequest(db, "tenant-1", "link-1", actor,
    "approve", "Independent owner review", "decision-independent");
  assert.equal(result.status, 200);
  const insertSql = db.batchCalls[0][0].sql;
  assert.match(insertSql, /r\.cloudflare_issuer = \?/);
  assert.match(insertSql, /\? = 'revoke' OR r\.cloudflare_subject <> \?/);
  assert.deepEqual(db.batchCalls[0][0].args.slice(-5), ["tenant-1", "owner-1", actor.issuer, "approve", actor.subject]);
});

test("pending review list excludes self-requests and mismatched Cloudflare issuers", async () => {
  const db = new DB();
  const result = await listPendingIdentityLinkRequests(db, "tenant-1", actor);
  assert.equal(result.status, 200);
  assert.match(db.queries.find(sql => sql.includes("FROM tenant_identity_link_requests r")), /r\.cloudflare_issuer = \?/);
  assert.match(db.queries.find(sql => sql.includes("FROM tenant_identity_link_requests r")), /r\.cloudflare_subject <> \?/);
});


test("SQL event trigger binds owner decisions to the request Cloudflare issuer", () => {
  const migrationPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../api/migrations/0022_tenant_identity_link_challenges.sql");
  const sql = readFileSync(migrationPath, "utf8");
  assert.match(sql, /r\.cloudflare_issuer = NEW\.actor_cloudflare_issuer/);
  assert.equal((sql.match(/r\.cloudflare_issuer = NEW\.actor_cloudflare_issuer/g) ?? []).length, 3);
});
