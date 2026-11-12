import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

const now = Math.floor(Date.now() / 1000);
class DB {
  constructor({ membership = true, grant = true, resource = true } = {}) {
    this.membership = membership; this.grant = grant; this.resource = resource; this.calls = [];
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { async run() {
      db.calls.push({ sql, args });
      if (sql.includes("FROM tenant_memberships")) return { results: db.membership ? [{
        subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer",
        membership_status: "active", tenant_status: "active",
      }] : [] };
      if (sql.includes("FROM tenant_resource_grants")) return { results: db.grant ? [{
        subject: "operator@example.test", tenant_id: "tenant-a", resource_type: "site",
        resource_id: "site-a", action: "read",
      }] : [] };
      if (sql.includes("FROM sites")) return { results: db.resource ? [{
        id: "site-a", tenant_id: "tenant-a", name: "Test site",
      }] : [] };
      throw new Error("unexpected SQL");
    } }; } };
  }
}
function request(headers = {}) {
  return new Request("https://private.internal/internal/v1/tenants/tenant-a/sites/site-a", {
    headers: { "x-nova-verified-subject": "operator@example.test",
      "x-nova-verified-issuer": "https://example.cloudflareaccess.com",
      "x-nova-verified-audience": "aud", "x-nova-gateway-issued-at": String(now),
      "x-nova-request-id": "request-123", ...headers },
  });
}
const env = db => ({ ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUDIENCE: "aud", DB: db });

test("requires a complete, fresh gateway identity envelope", async () => {
  const db = new DB();
  const response = await worker.fetch(request({ "x-nova-verified-issuer": "https://attacker.test" }), env(db));
  assert.equal(response.status, 401); assert.equal(db.calls.length, 0);
});
test("authorizes exact tenant membership and resource grant before scoped read", async () => {
  const db = new DB();
  const response = await worker.fetch(request(), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.name, "Test site");
  assert.deepEqual(db.calls[2].args, ["tenant-a", "site-a"]);
});
test("denies when exact resource grant is absent without reading resource", async () => {
  const db = new DB({ grant: false });
  const response = await worker.fetch(request(), env(db));
  assert.equal(response.status, 404); assert.equal(db.calls.length, 2);
});
test("denies duplicate or missing membership without grant lookup", async () => {
  const db = new DB({ membership: false });
  const response = await worker.fetch(request(), env(db));
  assert.equal(response.status, 404); assert.equal(db.calls.length, 1);
});
test("returns same not-found result for cross-tenant selection", async () => {
  const db = new DB();
  const response = await worker.fetch(new Request(
    "https://private.internal/internal/v1/tenants/tenant-b/sites/site-a", { headers: request().headers }), env(db));
  assert.equal(response.status, 404); assert.equal(db.calls.length, 1);
});
test("fails closed when D1 is unavailable", async () => {
  const response = await worker.fetch(request(), { ...env(null), DB: null });
  assert.equal(response.status, 503);
});
test("rejects unsupported methods and routes", async () => {
  assert.equal((await worker.fetch(new Request("https://private.internal/internal/v1/tenants/tenant-a/sites/site-a", { method: "POST" }), env(new DB()))).status, 404);
  assert.equal((await worker.fetch(new Request("https://private.internal/internal/debug"), env(new DB()))).status, 404);
});
