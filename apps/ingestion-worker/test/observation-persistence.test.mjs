import test from "node:test";
import assert from "node:assert/strict";
import { persistObservation } from "../src/observation-persistence.mjs";

const observation = {
  site_id: "site-001", asset_id: "asset-001", source_id: "source-001",
  source_capability_id: "capability-001", measurement_kind: "measured",
  acquisition_protocol: "field-gateway", protocol_version: "1.0",
  sampling_mode: "interval", sampling_interval_seconds: 900,
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
      assert.match(audit.sql, /source_capability_id = \?/);
      assert.match(audit.sql, /protocol_version = \?/);
      assert.match(audit.sql, /sampling_interval_seconds IS \?/);
      const v = insert.values;
      let inserted = false;
      const candidate = {
        id: v[0], site_id: v[1], tenant_id: v[2], asset_id: v[3], source_id: v[4],
        module: v[5], metric: v[6], value: v[7], unit: v[8],
        observed_at: v[9], idempotency_key: v[10],
        verification_status: "unverified", provenance_json: v[11],
        quality_flags_json: v[12], source_capability_id: v[13],
        measurement_kind: v[14], acquisition_protocol: v[15], protocol_version: v[16],
        sampling_mode: v[17], sampling_interval_seconds: v[18],
      };
      if (!state.observation) {
        state.observation = candidate;
        inserted = true;
      }
      const auditValues = audit.values;
      const auditMatchesExisting = state.observation &&
        state.observation.id === auditValues[6] &&
        state.observation.tenant_id === auditValues[7] &&
        state.observation.site_id === auditValues[8] &&
        state.observation.asset_id === auditValues[9] &&
        state.observation.source_id === auditValues[10] &&
        state.observation.module === auditValues[11] &&
        state.observation.metric === auditValues[12] &&
        Number(state.observation.value) === auditValues[13] &&
        state.observation.unit === auditValues[14] &&
        state.observation.observed_at === auditValues[15] &&
        state.observation.idempotency_key === auditValues[16] &&
        state.observation.provenance_json === auditValues[17] &&
        state.observation.quality_flags_json === auditValues[18] &&
        state.observation.source_capability_id === auditValues[19] &&
        state.observation.measurement_kind === auditValues[20] &&
        state.observation.acquisition_protocol === auditValues[21] &&
        state.observation.protocol_version === auditValues[22] &&
        state.observation.sampling_mode === auditValues[23] &&
        state.observation.sampling_interval_seconds === auditValues[24];
      if (auditMatchesExisting && !state.audit.some(row => row.id === auditValues[0])) {
        state.audit.push({ id: auditValues[0], tenant_id: auditValues[1], actor_id: auditValues[2] });
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
  const metadataChanged = { ...observation, protocol_version: "2.0" };
  const metadataResult = await persistObservation(db, metadataChanged, principal, null, tenantId);
  assert.deepEqual(metadataResult, { status: "idempotency_conflict", accepted: false });
  const result = await persistObservation(db, changed, principal, null, tenantId);
  assert.deepEqual(result, { status: "idempotency_conflict", accepted: false });
  assert.equal(db.state.audit.length, 1, "conflicting idempotency payloads must not create accepted audit events");
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
