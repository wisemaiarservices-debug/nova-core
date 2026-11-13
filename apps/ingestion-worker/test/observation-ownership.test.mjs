import test from "node:test";
import assert from "node:assert/strict";
import { resolveObservationOwnership } from "../src/observation-ownership.mjs";

const observation = { site_id: "site-001", asset_id: "asset-001", source_id: "source-001", module: "neoagro" };

function mockDatabase(rows) {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      return {
        bind(...values) {
          return { async first() {
            queries.push({ sql, values });
            if (sql.includes("FROM sites")) return rows.site ?? null;
            if (sql.includes("FROM sources")) return rows.source ?? null;
            if (sql.includes("FROM assets")) return rows.asset ?? null;
            throw new Error("unexpected_query");
          }};
        },
      };
    },
  };
}

const validRows = {
  site: { id: "site-001", status: "active", tenant_id: "tenant-a", tenant_status: "active" },
  source: { id: "source-001", site_id: "site-001", module: "neoagro", verification_status: "unverified", tenant_id: "tenant-a" },
  asset: { id: "asset-001", site_id: "site-001", status: "active", tenant_id: "tenant-a" },
};

test("returns server-resolved tenant for active same-tenant site, source and asset", async () => {
  const db = mockDatabase(validRows);
  assert.deepEqual(await resolveObservationOwnership(db, observation), { tenantId: "tenant-a" });
  assert.equal(db.queries.length, 3);
  assert.match(db.queries[0].sql, /JOIN tenants/);
});

test("allows a tenant-scoped global source without marking it verified", async () => {
  const db = mockDatabase({ ...validRows, source: { ...validRows.source, site_id: null } });
  assert.deepEqual(await resolveObservationOwnership(db, observation), { tenantId: "tenant-a" });
});

for (const [name, rows] of [
  ["unknown site", { ...validRows, site: null }],
  ["inactive site", { ...validRows, site: { ...validRows.site, status: "inactive" } }],
  ["unowned legacy site", { ...validRows, site: { id: "site-001", status: "active", tenant_id: null, tenant_status: null } }],
  ["suspended tenant", { ...validRows, site: { ...validRows.site, tenant_status: "suspended" } }],
  ["unknown source", { ...validRows, source: null }],
  ["source module mismatch", { ...validRows, source: { ...validRows.source, module: "neogrid" } }],
  ["disabled source", { ...validRows, source: { ...validRows.source, verification_status: "disabled" } }],
  ["source tenant mismatch", { ...validRows, source: { ...validRows.source, tenant_id: "tenant-b" } }],
  ["source owned by another site", { ...validRows, source: { ...validRows.source, site_id: "site-elsewhere" } }],
  ["unknown asset", { ...validRows, asset: null }],
  ["asset owned by another site", { ...validRows, asset: { ...validRows.asset, site_id: "site-elsewhere" } }],
  ["asset tenant mismatch", { ...validRows, asset: { ...validRows.asset, tenant_id: "tenant-b" } }],
  ["inactive asset", { ...validRows, asset: { ...validRows.asset, status: "inactive" } }],
]) {
  test("denies " + name, async () => {
    assert.equal(await resolveObservationOwnership(mockDatabase(rows), observation), null);
  });
}

test("site-level observation does not require an asset", async () => {
  const { asset_id, ...siteObservation } = observation;
  const db = mockDatabase(validRows);
  assert.deepEqual(await resolveObservationOwnership(db, siteObservation), { tenantId: "tenant-a" });
  assert.equal(db.queries.length, 2);
});

test("requires a configured D1 binding", async () => {
  await assert.rejects(() => resolveObservationOwnership(null, observation), /storage_not_configured/);
});
