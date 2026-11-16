import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createTenantAsset } from "../src/asset-registration.mjs";

globalThis.crypto ??= webcrypto;
const digest = "a".repeat(64);

class FakeDB {
  constructor() { this.existing = []; this.batchStatements = []; this.batchError = null; }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args, async all() {
      assert.match(sql, /tenant_asset_creation_requests/);
      return { results: db.existing };
    } }; } };
  }
  async batch(statements) {
    this.batchStatements = statements;
    if (this.batchError) throw this.batchError;
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

test("asset registration atomically creates an unconfigured asset, owner read grant and audit", async () => {
  const db = new FakeDB();
  const result = await createTenantAsset(db, "tenant-a", "site-a", "owner-sub",
    "request-1", "asset-onboarding-1", digest,
    { name: "Irrigation Pump 01", asset_type: "pump", external_ref: "pump-001" });
  assert.equal(result.status, 201);
  assert.equal(result.data.tenant_id, "tenant-a");
  assert.equal(result.data.site_id, "site-a");
  assert.equal(result.data.status, "unconfigured");
  assert.equal(result.data.created, true);
  assert.equal(db.batchStatements.length, 5);
  assert.match(db.batchStatements[0].sql, /INSERT INTO assets/);
  assert.match(db.batchStatements[0].sql, /'unconfigured'/);
  assert.match(db.batchStatements[1].sql, /'asset', \?, 'read'/);
  assert.match(db.batchStatements[2].sql, /tenant_resource_grant_events/);
  assert.match(db.batchStatements[3].sql, /tenant_asset_events/);
  assert.match(db.batchStatements[4].sql, /tenant_asset_creation_requests/);
});

test("same idempotency key and digest replay the original asset without a second write", async () => {
  const db = new FakeDB();
  db.existing = [{ request_sha256: digest, asset_id: "asset-original",
    name: "Pump 01", asset_type: "pump", external_ref: null, status: "unconfigured" }];
  const result = await createTenantAsset(db, "tenant-a", "site-a", "owner-sub",
    "request-retry", "asset-onboarding-1", digest, { name: "Pump 01", asset_type: "pump" });
  assert.equal(result.status, 200);
  assert.equal(result.data.id, "asset-original");
  assert.equal(result.data.created, false);
  assert.equal(db.batchStatements.length, 0);
});

test("idempotency conflict and invalid scope fields fail without writes", async () => {
  const db = new FakeDB();
  db.existing = [{ request_sha256: digest, asset_id: "asset-original",
    name: "Pump 01", asset_type: "pump", status: "unconfigured" }];
  const conflict = await createTenantAsset(db, "tenant-a", "site-a", "owner-sub",
    "request-retry", "asset-onboarding-1", "b".repeat(64),
    { name: "Other Pump", asset_type: "pump" });
  assert.equal(conflict.status, 409);
  for (const body of [
    { name: "Pump 01", asset_type: "pump", tenant_id: "tenant-b" },
    { name: " Pump 01", asset_type: "pump" },
    { name: "Pump 01", asset_type: "pump", status: "active" },
    { name: "Pump 01", asset_type: "pump", external_ref: "x".repeat(241) },
  ]) {
    const result = await createTenantAsset(new FakeDB(), "tenant-a", "site-a", "owner-sub",
      "request-1", "asset-onboarding-1", digest, body);
    assert.equal(result.status, 400);
  }
  assert.equal(db.batchStatements.length, 0);
});

test("failed asset batch is not reported as successful registration", async () => {
  const db = new FakeDB();
  db.batchError = new Error("audit rejected");
  await assert.rejects(() => createTenantAsset(db, "tenant-a", "site-a", "owner-sub",
    "request-1", "asset-onboarding-1", digest,
    { name: "Pump 01", asset_type: "pump" }), /audit rejected/);
});
