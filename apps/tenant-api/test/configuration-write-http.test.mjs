import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../src/index.mjs";

const SECRET = "test-only-internal-secret-with-32-bytes-minimum";
const now = Math.floor(Date.now() / 1000);
const payload = {
  tenant: { tenant_id: "tenant-a" },
  site: { site_id: "site-a", timezone: "Africa/Tunis", crops: [],
    irrigation_systems: [], energy_systems: [] },
};

class DB {
  constructor({ allowed = true } = {}) {
    this.allowed = allowed;
    this.calls = [];
    this.nonces = new Set();
    this.prior = null;
    this.batches = [];
  }
  prepare(sql) {
    const db = this;
    return { sql, args: [], bind(...args) { this.args = args; return this; },
      async all() {
        db.calls.push({ kind: "all", sql, args: this.args });
        if (sql.includes("tenant_memberships")) return { results: db.allowed ? [{
          subject: "operator@example.test", tenant_id: "tenant-a", role: "tenant_admin",
          membership_status: "active", tenant_status: "active",
        }] : [] };
        if (sql.includes("tenant_resource_grants")) return { results: db.allowed ? [{
          subject: "operator@example.test", tenant_id: "tenant-a", resource_type: "site",
          resource_id: "site-a", action: "create",
        }] : [] };
        if (sql.includes("tenant_site_configuration_idempotency")) return { results: db.prior ? [db.prior] : [] };
        return { results: [] };
      },
      async run() {
        db.calls.push({ kind: "run", sql, args: this.args });
        if (sql.includes("internal_request_nonces")) {
          const id = this.args[0];
          if (db.nonces.has(id)) return { meta: { changes: 0 } };
          db.nonces.add(id);
          return { meta: { changes: 1 } };
        }
        throw new Error("unexpected_run");
      },
    };
  }
  async batch(statements) {
    this.batches.push(statements);
    const reservation = statements[0].args;
    const snapshot = statements[1].args;
    this.prior = { request_sha256: reservation[3], configuration_id: reservation[4],
      status: "completed", response_json: JSON.stringify({
        configuration_id: reservation[4], configuration_version: "v1",
        site_id: snapshot[2], schema_id: snapshot[5], content_sha256: snapshot[7],
        request_id: snapshot[9], created_at: snapshot[10],
      }) };
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

async function signedRequest({ body = { payload, schema_id: "nova.client-config.v1" },
  path = "/internal/v1/tenants/tenant-a/sites/site-a/configurations",
  idempotencyKey = "configuration-idem-001", requestId = "configuration-request-001" } = {}) {
  const headers = new Headers({
    "x-nova-verified-subject": "operator@example.test",
    "x-nova-verified-issuer": "https://example.cloudflareaccess.com",
    "x-nova-verified-audience": "aud",
    "x-nova-gateway-issued-at": String(now),
    "x-nova-request-id": requestId,
    "x-nova-idempotency-key": idempotencyKey,
    "x-nova-verified-placeholder": "ignored",
    "content-type": "application/json",
  });
  const canonical = JSON.stringify(["POST", path, headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"), headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"), headers.get("x-nova-request-id")]);
  headers.set("x-nova-internal-signature",
    createHmac("sha256", SECRET).update(canonical).digest("hex"));
  return new Request("https://private.internal" + path, {
    method: "POST", headers, body: JSON.stringify(body),
  });
}
const env = DB => ({ ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUDIENCE: "aud", INTERNAL_AUTH_SECRET: SECRET, DB });

test("creates a site configuration only for an active tenant admin with exact site create grant", async () => {
  const db = new DB();
  const response = await worker.fetch(await signedRequest(), env(db));
  assert.equal(response.status, 201);
  const result = (await response.json()).data;
  assert.equal(result.configuration_version, "v1");
  assert.equal(result.site_id, "site-a");
  assert.equal(result.schema_id, "nova.client-config.v1");
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 5);
  assert.match(db.batches[0][0].sql, /tenant_site_configuration_idempotency/);
  assert.match(db.batches[0][1].sql, /tenant_site_configurations/);
  assert.match(db.batches[0][2].sql, /submitted_for_review/);
  assert.match(db.batches[0][3].sql, /audit_events/);
  assert.match(db.batches[0][4].sql, /status = 'completed'/);
});

test("denies configuration writes without tenant membership or exact site grant", async () => {
  const db = new DB({ allowed: false });
  const response = await worker.fetch(await signedRequest(), env(db));
  assert.equal(response.status, 404);
  assert.equal(db.batches.length, 0);
});

test("rejects missing idempotency key and caller-injected fields", async () => {
  const db = new DB();
  const missingKey = await worker.fetch(await signedRequest({ idempotencyKey: "" }), env(db));
  assert.equal(missingKey.status, 400);
  const injected = await worker.fetch(await signedRequest({
    requestId: "configuration-request-002",
    body: { payload, schema_id: "nova.client-config.v1", reviewer_subject: "forged" },
  }), env(db));
  assert.equal(injected.status, 400);
  assert.equal(db.batches.length, 0);
});

test("rejects tenant or site identity substitution in the payload", async () => {
  const db = new DB();
  const response = await worker.fetch(await signedRequest({
    body: { payload: { ...payload, site: { ...payload.site, site_id: "site-other" } },
      schema_id: "nova.client-config.v1" },
  }), env(db));
  assert.equal(response.status, 422);
  assert.equal(db.batches.length, 0);
});

test("rejects replayed gateway request IDs before attempting another write", async () => {
  const db = new DB();
  const req = await signedRequest();
  const first = await worker.fetch(req, env(db));
  assert.equal(first.status, 201);
  const replay = await worker.fetch(await signedRequest(), env(db));
  assert.equal(replay.status, 401);
  assert.equal(db.batches.length, 1);
});
