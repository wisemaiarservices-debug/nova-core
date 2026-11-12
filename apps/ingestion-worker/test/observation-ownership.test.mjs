import test from "node:test";
import assert from "node:assert/strict";
import { resolveObservationOwnership } from "../src/observation-ownership.mjs";

const observation = {
  site_id: "site-001",
  asset_id: "asset-001",
  source_id: "source-001",
  module: "neoagro",
};

function mockDatabase(rows) {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              queries.push({ sql, values });
              if (sql.includes("FROM sites")) return rows.site ?? null;
              if (sql.includes("FROM sources")) return rows.source ?? null;
              if (sql.includes("FROM assets")) return rows.asset ?? null;
              throw new Error("unexpected_query");
            },
          };
        },
      };
    },
  };
}

const validRows = {
  site: { id: "site-001", status: "active", tenant_id: "tenant-001" },
  source: { id: "source-001", site_id: "site-001", module: "neoagro", verification_status: "unverified", tenant_id: "tenant-001" },
  asset: { id: "asset-001", site_id: "site-001", status: "active", tenant_id: "tenant-001" },
};

test("allows active site, matching module source, and same-site active asset", async () => {
  const db = mockDatabase(validRows);
  assert.deepEqual(await resolveObservationOwnership(db, observation), { tenant_id: "tenant-001" });
  assert.equal(db.queries.length, 3);
});

test("allows an explicitly global source but does not mark it verified", async () => {
  const db = mockDatabase({
    ...validRows,
    source: { ...validRows.source, site_id: null, verification_status: "unverified" },
  });
  assert.deepEqual(await resolveObservationOwnership(db, observation), { tenant_id: "tenant-001" });
});

for (const [name, rows] of [
  ["unknown site", { ...validRows, site: null }],
  ["site without tenant ownership", { ...validRows, site: { id: "site-001", status: "active" } }],
  ["inactive site", { ...validRows, site: { ...validRows.site, status: "inactive" } }],
  ["unknown source", { ...validRows, source: null }],
  ["source module mismatch", { ...validRows, source: { ...validRows.source, module: "neogrid" } }],
  ["disabled source", { ...validRows, source: { ...validRows.source, verification_status: "disabled" } }],
  ["source owned by another site", { ...validRows, source: { ...validRows.source, site_id: "site-elsewhere" } }],
  ["source owned by another tenant", { ...validRows, source: { ...validRows.source, tenant_id: "tenant-elsewhere" } }],
  ["unknown asset", { ...validRows, asset: null }],
  ["asset owned by another site", { ...validRows, asset: { ...validRows.asset, site_id: "site-elsewhere" } }],
  ["asset owned by another tenant", { ...validRows, asset: { ...validRows.asset, tenant_id: "tenant-elsewhere" } }],
  ["inactive asset", { ...validRows, asset: { ...validRows.asset, status: "inactive" } }],
]) {
  test("denies " + name, async () => {
    const db = mockDatabase(rows);
    assert.equal(await resolveObservationOwnership(db, observation), null);
  });
}

test("site-level observation does not require an asset", async () => {
  const db = mockDatabase(validRows);
  const { asset_id, ...siteObservation } = observation;
  assert.deepEqual(await resolveObservationOwnership(db, siteObservation), { tenant_id: "tenant-001" });
  assert.equal(db.queries.length, 2);
});

test("requires a configured D1 binding", async () => {
  await assert.rejects(() => resolveObservationOwnership(null, observation), /storage_not_configured/);
});
