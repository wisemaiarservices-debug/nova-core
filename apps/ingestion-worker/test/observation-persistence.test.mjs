import test from "node:test";
import assert from "node:assert/strict";
import { persistObservation } from "../src/observation-persistence.mjs";

const observation = {
  site_id: "site-001", asset_id: "asset-001", source_id: "source-001",
  module: "neoagro", metric: "soil_moisture", value: 28.5, unit: "%",
  observed_at: "2026-11-10T10:00:00.000Z",
  idempotency_key: "neoagro-gateway-1:reading-0001",
  provenance: { provider: "field-gateway-1", acquisition_method: "sensor" },
  quality_flags: [],
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
        bind(...values) {
          this.values = values;
          state.statements.push({ sql, values });
          return this;
        },
        async first() {
          if (sql.includes("FROM observations WHERE source_id")) return state.observation;
          throw new Error("unexpected_first_query");
        },
      };
    },
    async batch(statements) {
      state.batches += 1;
      assert.equal(statements.length, 2, "observation and tenant audit must share one D1 batch");
      const insert = statements[0];
      const audit = statements[1];
      assert.match(insert.sql, /INSERT OR IGNORE INTO observations/);
      assert.match(insert.sql, /site_id, tenant_id, asset_id/);
      assert.match(audit.sql, /INSERT OR IGNORE INTO audit_events/);
      assert.match(audit.sql, /id, tenant_id, actor_type/);
      assert.match(audit.sql, /WHERE EXISTS/);
      const v = insert.values;
      let inserted = false;
      if (!state.observation) {
        state.observation = {
          id: v[0], site_id: v[1], tenant_id: v[2], asset_id: v[3], source_id: v[4],
          module: v[5], metric: v[6], value: v[7], unit: v[8],
          observed_at: v[9], idempotency_key: v[10],
          verification_status: "unverified", provenance_json: v[11],
          quality_flags_json: v[12],
        };
        state.audit.push({ id: audit.values[0], tenant_id: audit.values[1], actor_id: audit.values[2] });
        inserted = true;
      } else if (state.observation.id === v[0]) {
        // An exact retry does not create another audit row.
      }
      return [{ success: true, meta: { changes: inserted ? 1 : 0 } }, { success: true }];
    },
  };
  return db;
}

test("inserts observation and tenant-scoped audit atomically with unverified state", async () => {
  const db = mockD1();
  const result = await persistObservation(db, observation, principal, "request-001", tenantId);
  assert.equal(result.status, "accepted");
  assert.equal(result.accepted, true);
  assert.equal(result.verification_status, "unverified");
  assert.equal(db.state.batches, 1);
  assert.equal(db.state.audit.length, 1);
  assert.equal(db.state.audit[0].actor_id, principal.serviceId);
  assert.equal(db.state.audit[0].tenant_id, tenantId);
  assert.equal(db.state.observation.tenant_id, tenantId);
});

test("retries return the original tenant-owned observation without duplicating audit", async () => {
  const db = mockD1();
  const first = await persistObservation(db, observation, principal, null, tenantId);
  const second = await persistObservation(db, observation, principal, null, tenantId);
  assert.equal(first.observation_id, second.observation_id);
  assert.equal(second.status, "already_accepted");
  assert.equal(second.idempotent, true);
  assert.equal(db.state.batches, 2);
  assert.equal(db.state.audit.length, 1);
});

test("rejects reuse of an idempotency key for different measurement content", async () => {
  const db = mockD1();
  await persistObservation(db, observation, principal, null, tenantId);
  const changed = { ...observation, value: 99 };
  const result = await persistObservation(db, changed, principal, null, tenantId);
  assert.deepEqual(result, { status: "idempotency_conflict", accepted: false });
});

test("rejects a row or retry from another tenant", async () => {
  const db = mockD1();
  const result = await persistObservation(db, observation, principal, null, "tenant-b");
  assert.equal(result.status, "accepted");
  assert.equal(db.state.observation.tenant_id, "tenant-b");
  const samePayload = await persistObservation(db, observation, principal, null, tenantId);
  assert.deepEqual(samePayload, { status: "idempotency_conflict", accepted: false });
});

test("rejects missing D1 batch support", async () => {
  await assert.rejects(
    () => persistObservation({ prepare() {} }, observation, principal, null, tenantId),
    /storage_not_configured/,
  );
});

test("requires both a verified service principal and server-resolved tenant", async () => {
  await assert.rejects(
    () => persistObservation(mockD1(), observation, null, null, tenantId),
    /verified_service_principal_and_tenant_required/,
  );
  await assert.rejects(
    () => persistObservation(mockD1(), observation, principal),
    /verified_service_principal_and_tenant_required/,
  );
});
