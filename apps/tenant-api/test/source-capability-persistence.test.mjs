import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { createSourceCapabilityDraft } from "../src/source-capability-persistence.mjs";

const draft = () => ({
  source_id: "source-unit-test",
  module: "neoagro",
  metric: "soil_ec",
  unit: "dS/m",
  measurement_kind: "measured",
  quantity_semantics: "Electrical conductivity of irrigation water",
  acquisition_protocol: "manual-lab",
  protocol_version: "1.0",
  sampling: { mode: "interval", interval_seconds: 3600, max_age_seconds: 86400 },
  timestamp: { max_future_skew_seconds: 300, timezone: "Africa/Tunis" },
  quality: { allowed_flags: ["suspect"] },
  calibration: { required: false, profile_ref: null },
  data_rights_ref: "fixture:rights",
  evidence_ref: "fixture:evidence",
  version: 1,
});

function fixtureDb() {
  const state = { request: null, batches: 0, statements: [] };
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          state.statements.push({ sql, args });
          return this;
        },
        async all() {
          if (sql.includes("FROM tenant_memberships")) return { results: [{
            role: "tenant_owner", membership_status: "active", tenant_status: "active",
          }] };
          if (sql.includes("FROM tenant_resource_grants")) return { results: [{ allowed: 1 }] };
          if (sql.includes("FROM sources")) return { results: [{
            id: "source-unit-test", tenant_id: "tenant-unit-test", site_id: "site-unit-test",
            module: "neoagro", verification_status: "verified",
          }] };
          if (sql.includes("FROM assets")) return { results: [] };
          if (sql.includes("FROM source_capability_creation_requests")) {
            return { results: state.request ? [state.request] : [] };
          }
          throw new Error("unexpected_query:" + sql);
        },
      };
    },
    async batch(statements) {
      state.batches += 1;
      assert.equal(statements.length, 3);
      for (const statement of statements) {
        assert.equal((statement.sql.match(/\?/g) || []).length, statement.args.length,
          "SQL placeholder count must match bound arguments");
      }
      const args = statements[2].args;
      state.request = {
        request_sha256: args[5], capability_id: args[6], request_id: args[7],
        response_json: args[8],
      };
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return { db, state };
}

const common = {
  principalSubject: "https://issuer.example|opaque-subject:123",
  tenantId: "tenant-unit-test",
  siteId: "site-unit-test",
  idempotencyKey: "unit-test-key",
  requestId: "unit-test-request",
  cryptoProvider: { subtle: webcrypto.subtle, randomUUID },
};

test("creates one immutable pending draft with atomic audit and idempotency statements", async () => {
  const { db, state } = fixtureDb();
  const result = await createSourceCapabilityDraft({ ...common, db, draft: draft() });
  assert.equal(result.replayed, false);
  assert.equal(result.status, "pending");
  assert.equal(result.created_by_subject, common.principalSubject);
  assert.equal(state.batches, 1);
  assert.match(state.request.request_sha256, /^[a-f0-9]{64}$/);
  assert.equal(state.statements.length, 3);
});

test("exact retry replays stored response without a second write batch", async () => {
  const { db, state } = fixtureDb();
  const first = await createSourceCapabilityDraft({ ...common, db, draft: draft() });
  const second = await createSourceCapabilityDraft({ ...common, db, draft: draft() });
  assert.equal(second.replayed, true);
  assert.equal(second.capability_id, first.capability_id);
  assert.equal(state.batches, 1);
});

test("same idempotency key with a different canonical payload conflicts", async () => {
  const { db, state } = fixtureDb();
  await createSourceCapabilityDraft({ ...common, db, draft: draft() });
  const changed = draft();
  changed.quantity_semantics = "A different measurement meaning";
  await assert.rejects(
    createSourceCapabilityDraft({ ...common, db, draft: changed }),
    /source_capability_idempotency_conflict/,
  );
  assert.equal(state.batches, 1);
});

test("caller cannot supply tenant or site identity in the draft", async () => {
  const { db, state } = fixtureDb();
  const invalid = { ...draft(), tenant_id: "tenant-attacker" };
  await assert.rejects(
    createSourceCapabilityDraft({ ...common, db, draft: invalid }),
    /source_capability_draft_invalid/,
  );
  assert.equal(state.batches, 0);
});
