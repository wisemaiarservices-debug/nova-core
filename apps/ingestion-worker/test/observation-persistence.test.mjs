import test from "node:test";
import assert from "node:assert/strict";
import { persistObservation } from "../src/observation-persistence.mjs";

const observation = {
  tenant_id: "tenant-001",
  site_id: "site-001",
  asset_id: "asset-001",
  source_id: "source-001",
  module: "neoagro",
  metric: "soil_moisture",
  value: 28.5,
  unit: "%",
  observed_at: "2026-11-10T10:00:00.000Z",
  idempotency_key: "neoagro-gateway-1:reading-0001",
  provenance: { provider: "field-gateway-1", acquisition_method: "sensor" },
  quality_flags: [],
};
const principal = { serviceId: "neoagro-ingestion-service" };

function mockD1(existing = null) {
  const state = { observation: existing, audit: [], batches: 0, statements: [] };
  const db = {
    state,
    prepare(sql) {
      return {
        sql,
        values: [],
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
      assert.equal(statements.length, 2, "observation and audit must share one D1 batch");
      const insert = statements[0];
      const audit = statements[1];
      assert.match(insert.sql, /INSERT OR IGNORE INTO observations/);
      assert.match(audit.sql, /INSERT OR IGNORE INTO audit_events/);
      assert.match(audit.sql, /WHERE EXISTS/);
      const v = insert.values;
      let inserted = false;
      if (!state.observation) {
        state.observation = {
          id: v[0], tenant_id: v[1], site_id: v[2], asset_id: v[3], source_id: v[4],
          module: v[5], metric: v[6], value: v[7], unit: v[8],
          observed_at: v[9], idempotency_key: v[10],
          verification_status: "unverified", provenance_json: v[11],
          quality_flags_json: v[12],
        };
        state.audit.push({ id: audit.values[0], actor_id: audit.values[1], tenant_id: audit.values[5] });
        inserted = true;
      } else if (state.observation.id === v[0]) {
        // A retry is ignored by the unique key and does not create a second audit event.
      }
      return [{ success: true, meta: { changes: inserted ? 1 : 0 } }, { success: true }];
    },
  };
  return db;
}

test("inserts observation and audit atomically with server-owned unverified state", async () => {
  const db = mockD1();
  const result = await persistObservation(db, observation, principal, "request-001");
  assert.equal(result.status, "accepted");
  assert.equal(result.accepted, true);
  assert.equal(result.verification_status, "unverified");
  assert.equal(db.state.batches, 1);
  assert.equal(db.state.audit.length, 1);
  assert.equal(db.state.audit[0].actor_id, principal.serviceId);
  assert.equal(db.state.observation.tenant_id, "tenant-001");
  assert.equal(db.state.audit[0].tenant_id, "tenant-001");
});

test("retries return the original observation without duplicating the audit event", async () => {
  const db = mockD1();
  const first = await persistObservation(db, observation, principal);
  const second = await persistObservation(db, observation, principal);
  assert.equal(first.observation_id, second.observation_id);
  assert.equal(second.status, "already_accepted");
  assert.equal(second.idempotent, true);
  assert.equal(db.state.batches, 2);
  assert.equal(db.state.audit.length, 1);
});

test("rejects reuse of an idempotency key for different measurement content", async () => {
  const db = mockD1();
  await persistObservation(db, observation, principal);
  const changed = { ...observation, value: 99 };
  const result = await persistObservation(db, changed, principal);
  assert.deepEqual(result, { status: "idempotency_conflict", accepted: false });
});

test("rejects missing D1 batch support", async () => {
  await assert.rejects(
    () => persistObservation({ prepare() {} }, observation, principal),
    /storage_not_configured/,
  );
});

test("rejects an absent service principal", async () => {
  await assert.rejects(() => persistObservation(mockD1(), observation, null), /verified_service_principal_required/);
});
