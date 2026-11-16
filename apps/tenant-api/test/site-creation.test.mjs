import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createTenantSite } from "../src/site-creation.mjs";

globalThis.crypto ??= webcrypto;
const digest = "a".repeat(64);

class FakeDB {
  constructor() {
    this.existing = [];
    this.batchStatements = [];
    this.batchResult = null;
    this.batchError = null;
    this.lookupCount = 0;
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          sql,
          args,
          async all() {
            db.lookupCount += 1;
            assert.match(sql, /tenant_site_creation_requests/);
            return { results: db.existing };
          },
        };
      },
    };
  }
  async batch(statements) {
    this.batchStatements = statements;
    if (this.batchError) throw this.batchError;
    return this.batchResult ?? statements.map(() => ({ meta: { changes: 1 } }));
  }
}

test("first-site creation atomically inserts the site, exact owner read grant, audit and idempotency record", async () => {
  const db = new FakeDB();
  const result = await createTenantSite(db, "tenant-a", "owner-sub", "request-1",
    "first-site-setup-1", digest, { name: "North Farm" });
  assert.equal(result.status, 201);
  assert.equal(result.data.tenant_id, "tenant-a");
  assert.equal(result.data.name, "North Farm");
  assert.equal(result.data.status, "active");
  assert.equal(result.data.created, true);
  assert.equal(db.batchStatements.length, 5);
  assert.match(db.batchStatements[0].sql, /INSERT INTO sites/);
  assert.match(db.batchStatements[0].sql, /role = 'tenant_owner'/);
  assert.match(db.batchStatements[1].sql, /'site', \?, 'read'/);
  assert.match(db.batchStatements[2].sql, /tenant_site_grant_events/);
  assert.match(db.batchStatements[3].sql, /tenant_site_events/);
  assert.match(db.batchStatements[4].sql, /tenant_site_creation_requests/);
});

test("same idempotency key and body replays the original site without a second write", async () => {
  const db = new FakeDB();
  db.existing = [{ request_sha256: digest, site_id: "site-original",
    name: "North Farm", status: "active", timezone: null }];
  const result = await createTenantSite(db, "tenant-a", "owner-sub", "request-retry",
    "first-site-setup-1", digest, { name: "North Farm" });
  assert.equal(result.status, 200);
  assert.equal(result.data.id, "site-original");
  assert.equal(result.data.created, false);
  assert.equal(db.batchStatements.length, 0);
});

test("idempotency key cannot be reused for a different request digest", async () => {
  const db = new FakeDB();
  db.existing = [{ request_sha256: digest, site_id: "site-original",
    name: "North Farm", status: "active", timezone: null }];
  const result = await createTenantSite(db, "tenant-a", "owner-sub", "request-retry",
    "first-site-setup-1", "b".repeat(64), { name: "South Farm" });
  assert.deepEqual(result, { error: "site_creation_idempotency_conflict", status: 409 });
  assert.equal(db.batchStatements.length, 0);
});

test("rejects extra fields, untrimmed names and malformed idempotency keys", async () => {
  const db = new FakeDB();
  for (const [key, body] of [
    ["first-site-setup-1", { name: "North Farm", tenant_id: "tenant-b" }],
    ["first-site-setup-1", { name: " North Farm " }],
    ["bad key", { name: "North Farm" }],
  ]) {
    const result = await createTenantSite(db, "tenant-a", "owner-sub", "request-1",
      key, digest, body);
    assert.equal(result.status, 400);
  }
  assert.equal(db.batchStatements.length, 0);
});

test("failed atomic batch is not reported as a created site", async () => {
  const db = new FakeDB();
  db.batchError = new Error("audit trigger rejected");
  await assert.rejects(() => createTenantSite(db, "tenant-a", "owner-sub",
    "request-1", "first-site-setup-1", digest, { name: "North Farm" }), /audit trigger rejected/);
});
