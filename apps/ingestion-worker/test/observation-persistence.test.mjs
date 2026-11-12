import test from "node:test";
import assert from "node:assert/strict";
import { persistObservation } from "../src/observation-persistence.mjs";

const observation = {
  site_id: "site-001", asset_id: "asset-001", source_id: "source-001", module: "neoagro",
  metric: "soil_moisture", value: 28.5, unit: "%", observed_at: "2026-11-10T10:00:00.000Z",
  idempotency_key: "neoagro-gateway-1:reading-0001",
  provenance: { provider: "field-gateway-1", acquisition_method: "sensor" }, quality_flags: [],
};
const principal = { serviceId: "neoagro-ingestion-service" };
const tenantId = "tenant-a";

function mockD1(existing = null) {
  const state = { observation: existing, audit: [], batches: 0, statements: [] };
  const db = {
    state,
    prepare(sql) {
      return {
        sql, values: [],
        bind(...values) { this.values = values; state.statements.push({ sql, values }); return this; },
        async first() {
          if (sql.includes("FROM observations WHERE source_id")) return state.observation;
          throw new Error("unexpected_first_query");
        },
      };
    },
    async batch(statements) {
      state.batches += 1;
      assert.equal(statements.length, 2, "observation and audit must share one D1 batch");
      const insert = statements[0], audit = statements[1], v = insert.values;
      assert.match(insert.sql, /tenant_id/);
      assert.match(audit.sql, /tenant_id/);
      let inserted = false;
      if (!state.observation) {
        state.observation = {
          id: v[0], site_id: v[1], asset_id: v[2], source_id: v[3], module: v[4],
          metric: v[5], value: v[6], unit: v[7], observed_at: v[8], idempotency_key: v[9],
          verification_status: "unverified", provenance_json: v[10], quality_flags_json: v[11],
          tenant_id: v[12],
        };
        state.audit.push({ id: audit.values[0], actor_id: audit.values[1], tenant_id: audit.values[5] });
        inserted = true;
      }
      return [{ success: true, meta: { changes: inserted ? 1 : 0 } }, { success: true }];
    },
  };
  return db;
}

test("writes server-resolved tenant to observation and audit atomically; keeps verification unverified", async () => {
  const db = mockD1();
  const result = await persistObservation(db, observation, principal, tenantId, "request-001");
  assert.equal(result.status, "accepted");
  assert.equal(result.accepted, true);
  assert.equal(result.verification_status, "unverified");
  assert.equal(db.state.observation.tenant_id, tenantId);
  assert.equal(db.state.audit[0].tenant_id, tenantId);
  assert.equal(db.state.batches, 1);
});

test("retries return the original tenant-owned observation without duplicating its audit", async () => {
  const db = mockD1();
  const first = await persistObservation(db, observation, principal, tenantId);
  const second = await persistObservation(db, observation, principal, tenantId);
  assert.equal(first.observation_id, second.observation_id);
  assert.equal(second.status, "already_accepted");
  assert.equal(second.idempotent, true);
  assert.equal(db.state.batches, 2);
  assert.equal(db.state.audit.length, 1);
});

test("rejects idempotency reuse with different measurement content", async () => {
  const db = mockD1();
  await persistObservation(db, observation, principal, tenantId);
  const result = await persistObservation(db, { ...observation, value: 99 }, principal, tenantId);
  assert.deepEqual(result, { status: "idempotency_conflict", accepted: false });
});

test("rejects absent tenant ownership", async () => {
  await assert.rejects(() => persistObservation(mockD1(), observation, principal, null), /verified_tenant_ownership_required/);
  await assert.rejects(() => persistObservation(mockD1(), observation, principal, " tenant-a "), /verified_tenant_ownership_required/);
});

test("rejects missing D1 batch support and absent service principal", async () => {
  await assert.rejects(() => persistObservation({ prepare() {} }, observation, principal, tenantId), /storage_not_configured/);
  await assert.rejects(() => persistObservation(mockD1(), observation, null, tenantId), /verified_service_principal_required/);
});
