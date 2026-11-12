import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../src/index.mjs";

const now = Math.floor(Date.now() / 1000);
class DB {
  constructor({ membership = true, grant = true, resource = true } = {}) {
    this.membership = membership; this.grant = grant; this.resource = resource; this.calls = []; this.nonces = new Set();
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return {
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("FROM tenant_memberships")) return { results: db.membershipRows ?? (db.membership ? [{
          subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer",
          membership_status: "active", tenant_status: "active",
        }] : []) };
        if (sql.includes("FROM tenant_resource_grants")) return { results: db.grant ? [{
          subject: "operator@example.test", tenant_id: "tenant-a", resource_type: args[2],
          resource_id: args[3], action: "read",
        }] : [] };
        if (/FROM (sites|assets|sources|observations|audit_events)/.test(sql)) return { results: db.resource ? [{
          id: args[1], tenant_id: args[0], name: "Test resource",
        }] : [] };
        throw new Error("unexpected SQL");
      },
      async run() {
        db.calls.push({ sql, args });
        if (sql.includes("INSERT INTO internal_request_nonces")) {
          if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
          db.nonces.add(args[0]);
          return { meta: { changes: 1 } };
        }
        throw new Error("unexpected write SQL");
      },
    }; } };
  }
}
const SECRET = "test-only-internal-secret-with-32-bytes-minimum";
async function request(overrides = {}, targetUrl = "https://private.internal/internal/v1/tenants/tenant-a/sites/site-a") {
  const url = targetUrl;
  const headers = new Headers({ "x-nova-verified-subject": "operator@example.test",
    "x-nova-verified-issuer": "https://example.cloudflareaccess.com",
    "x-nova-verified-audience": "aud", "x-nova-gateway-issued-at": String(now),
    "x-nova-request-id": "request-123", ...overrides });
  const path = new URL(url).pathname;
  const canonical = JSON.stringify(["GET", path, headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"), headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"), headers.get("x-nova-request-id")]);
  headers.set("x-nova-internal-signature",
    createHmac("sha256", SECRET).update(canonical).digest("hex"));
  return new Request(url, { headers });
}
const env = db => ({ ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUDIENCE: "aud", INTERNAL_AUTH_SECRET: SECRET, DB: db });

test("requires a complete, fresh gateway identity envelope", async () => {
  const db = new DB();
  const response = await worker.fetch(await request({ "x-nova-verified-issuer": "https://attacker.test" }), env(db));
  assert.equal(response.status, 401); assert.equal(db.calls.length, 0);
});
test("authorizes exact tenant membership and resource grant before scoped read", async () => {
  const db = new DB();
  const response = await worker.fetch(await request(), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.name, "Test resource");
  assert.deepEqual(db.calls[3].args, ["tenant-a", "site-a"]);
});
test("denies when exact resource grant is absent without reading resource", async () => {
  const db = new DB({ grant: false });
  const response = await worker.fetch(await request(), env(db));
  assert.equal(response.status, 404); assert.equal(db.calls.length, 3);
});
test("denies duplicate or missing membership without grant lookup", async () => {
  const db = new DB({ membership: false });
  const response = await worker.fetch(await request(), env(db));
  assert.equal(response.status, 404); assert.equal(db.calls.length, 2);
});
test("returns same not-found result for cross-tenant selection", async () => {
  const db = new DB();
  const response = await worker.fetch(await request({},
    "https://private.internal/internal/v1/tenants/tenant-b/sites/site-a"), env(db));
  assert.equal(response.status, 404); assert.equal(db.calls.length, 2);
});
test("rejects forged signatures, path tampering, and missing internal secret", async () => {
  const signed = await request();
  const forgedHeaders = new Headers(signed.headers);
  forgedHeaders.set("x-nova-internal-signature", "A".repeat(64));
  assert.equal((await worker.fetch(new Request(signed.url, { headers: forgedHeaders }), env(new DB()))).status, 401);
  const pathTamper = new Request("https://private.internal/internal/v1/tenants/tenant-a/assets/site-a", { headers: signed.headers });
  assert.equal((await worker.fetch(pathTamper, env(new DB()))).status, 401);
  assert.equal((await worker.fetch(signed, { ...env(new DB()), INTERNAL_AUTH_SECRET: undefined })).status, 401);
});
test("consumes each signed request ID exactly once", async () => {
  const db = new DB();
  const first = await worker.fetch(await request(), env(db));
  assert.equal(first.status, 200);
  const callsAfterFirst = db.calls.length;
  const replay = await worker.fetch(await request(), env(db));
  assert.equal(replay.status, 401);
  assert.equal(db.calls.length, callsAfterFirst + 1);
});
test("rejects signed envelopes outside the 120-second freshness window", async () => {
  const stale = await request({ "x-nova-gateway-issued-at": String(now - 121) });
  const future = await request({ "x-nova-gateway-issued-at": String(now + 31) });
  assert.equal((await worker.fetch(stale, env(new DB()))).status, 401);
  assert.equal((await worker.fetch(future, env(new DB()))).status, 401);
});
test("fails closed when D1 is unavailable", async () => {
  const response = await worker.fetch(await request(), { ...env(null), DB: null });
  assert.equal(response.status, 503);
});
test("rejects unsupported methods and routes", async () => {
  assert.equal((await worker.fetch(new Request("https://private.internal/internal/v1/tenants/tenant-a/sites/site-a", { method: "POST" }), env(new DB()))).status, 404);
  assert.equal((await worker.fetch(new Request("https://private.internal/internal/debug"), env(new DB()))).status, 404);
});

test("maps every allowlisted route to its canonical resource grant and scoped SQL", async () => {
  const cases = [
    ["sites", "site"], ["assets", "asset"], ["sources", "source"],
    ["observations", "observation"], ["audit-events", "audit_event"],
  ];
  for (const [route, expectedType] of cases) {
    const db = new DB();
    const response = await worker.fetch(new Request(
      `https://private.internal/internal/v1/tenants/tenant-a/${route}/resource-1`,
      { headers: (await request({}, `https://private.internal/internal/v1/tenants/tenant-a/${route}/resource-1`)).headers }), env(db));
    assert.equal(response.status, 200, route);
    assert.equal(db.calls[2].args[2], expectedType, route);
    assert.deepEqual(db.calls[3].args, ["tenant-a", "resource-1"], route);
  }
});
test("denies inactive tenant membership and unknown roles before grant lookup", async () => {
  for (const patch of [
    { membership: [{ subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer",
      membership_status: "active", tenant_status: "suspended" }] },
    { membership: [{ subject: "operator@example.test", tenant_id: "tenant-a", role: "unknown",
      membership_status: "active", tenant_status: "active" }] },
  ]) {
    const db = new DB();
    if (patch.membership) db.membershipRows = patch.membership;
    const response = await worker.fetch(await request(), env(db));
    assert.equal(response.status, 404);
    assert.equal(db.calls.length, 2);
  }
});
