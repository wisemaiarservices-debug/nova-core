import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../src/index.mjs";

const SECRET = "test-only-internal-secret-with-32-bytes-minimum";
const now = Math.floor(Date.now() / 1000);
class DB {
  constructor({ authorized = true, list = false } = {}) {
    this.authorized = authorized; this.list = list; this.calls = []; this.batches = [];
  }
  prepare(sql) {
    const db = this;
    return { sql, args: [], bind(...args) { this.args = args; return this; },
      async run() { return { meta: { changes: 1 } }; },
      async all() {
        db.calls.push({ sql, args: this.args });
        if (sql.includes("tenant_memberships")) return { results: db.authorized ? [{
          subject: "owner@example.test", tenant_id: "tenant-a", role: "tenant_owner",
          membership_status: "active", tenant_status: "active",
        }] : [] };
        if (sql.includes("tenant_resource_grants")) return { results: db.authorized ? [{
          subject: "owner@example.test", tenant_id: "tenant-a", resource_type: "site",
          resource_id: "site-a", action: sql.includes("manage_members") ? "manage_members" : "read",
        }] : [] };
        if (sql.includes("tenant_site_configuration_reviewers")) return { results: [{
          reviewer_subject: "engineer@example.test", reviewer_role: "engineering_reviewer",
          status: "active", assigned_by_subject: "owner@example.test",
          assignment_evidence_ref: "evidence:assignment", created_at: "2026-11-13T00:00:00Z",
        }] };
        if (sql.includes("tenant_site_configuration_reviewer_events")) return { results: [{
          reviewer_subject: "engineer@example.test", reviewer_role: "engineering_reviewer",
          event_type: "assigned", actor_subject: "owner@example.test",
          evidence_ref: "evidence:assignment", reason: null, request_id: "request-1",
          occurred_at: "2026-11-13T00:00:00Z",
        }] };
        return { results: [] };
      },
    };
  }
  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}
function signedRequest({ method = "POST", path = "/internal/v1/tenants/tenant-a/sites/site-a/configurations/reviewers/assign",
  body = { reviewer_subject: "engineer@example.test", reviewer_role: "engineering_reviewer",
    evidence_ref: "evidence:assignment" }, requestId = "configuration-reviewer-request-1" } = {}) {
  const headers = new Headers({
    "x-nova-verified-subject": "owner@example.test",
    "x-nova-verified-issuer": "https://example.cloudflareaccess.com",
    "x-nova-verified-audience": "aud", "x-nova-gateway-issued-at": String(now),
    "x-nova-request-id": requestId,
  });
  const canonical = JSON.stringify([method, path, headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"), headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"), headers.get("x-nova-request-id")]);
  headers.set("x-nova-internal-signature", createHmac("sha256", SECRET).update(canonical).digest("hex"));
  if (method === "POST") headers.set("content-type", "application/json");
  return new Request("https://private.internal" + path, {
    method, headers, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
const env = DB => ({ ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUDIENCE: "aud", INTERNAL_AUTH_SECRET: SECRET, DB });

test("tenant owner with exact site manage_members grant assigns reviewer with append-only event and audit batch", async () => {
  const db = new DB();
  const response = await worker.fetch(signedRequest(), env(db));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.reviewer_role, "engineering_reviewer");
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 3);
  assert.match(db.batches[0][0].sql, /tenant_site_configuration_reviewers/);
  assert.match(db.batches[0][1].sql, /tenant_site_configuration_reviewer_events/);
  assert.match(db.batches[0][2].sql, /audit_events/);
});

test("reviewer assignment rejects self-assignment, forged roles and unknown request fields", async () => {
  for (const body of [
    { reviewer_subject: "owner@example.test", reviewer_role: "engineering_reviewer", evidence_ref: "e" },
    { reviewer_subject: "reviewer", reviewer_role: "tenant_admin", evidence_ref: "e" },
    { reviewer_subject: "reviewer", reviewer_role: "engineering_reviewer", evidence_ref: "e", status: "active" },
  ]) {
    const db = new DB();
    const response = await worker.fetch(signedRequest({ body }), env(db));
    assert.equal(response.status, 400);
    assert.equal(db.batches.length, 0);
  }
});

test("reviewer provisioning requires owner membership and exact site manage_members grant", async () => {
  const db = new DB({ authorized: false });
  const response = await worker.fetch(signedRequest(), env(db));
  assert.equal(response.status, 404);
  assert.equal(db.batches.length, 0);
});

test("reviewer list is read-scoped and returns assignment plus immutable event history", async () => {
  const db = new DB();
  const path = "/internal/v1/tenants/tenant-a/sites/site-a/configurations/reviewers";
  const response = await worker.fetch(signedRequest({ method: "GET", path }), env(db));
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.assignments[0].reviewer_role, "engineering_reviewer");
  assert.equal(data.events[0].event_type, "assigned");
});


test("revocation requires a reason and records a terminal reviewer event", async () => {
  const db = new DB();
  const path = "/internal/v1/tenants/tenant-a/sites/site-a/configurations/reviewers/revoke";
  const body = { reviewer_subject: "engineer@example.test",
    reviewer_role: "engineering_reviewer", evidence_ref: "evidence:revocation",
    reason: "Assignment ended" };
  const response = await worker.fetch(signedRequest({ path, body,
    requestId: "configuration-reviewer-revoke-1" }), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, "revoked");
  assert.equal(db.batches.length, 1);
  assert.match(db.batches[0][0].sql, /UPDATE tenant_site_configuration_reviewers SET status = 'revoked'/);
  assert.match(db.batches[0][1].sql, /event_type, actor_subject, evidence_ref, reason/);
});
