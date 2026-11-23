import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { recordSourceCapabilityEvent } from "../src/source-capability-persistence.mjs";

function fixtureDb({ reviewer = false } = {}) {
  const state = { request: null, batches: 0 };
  const db = {
    prepare(sql) {
      return {
        sql, args: [],
        bind(...args) { this.args = args; return this; },
        async all() {
          if (sql.includes("FROM tenant_memberships")) return { results: [{
            role: reviewer ? "viewer" : "tenant_owner",
            membership_status: "active", tenant_status: "active",
          }] };
          if (sql.includes("FROM tenant_resource_grants")) return { results: [{ allowed: 1 }] };
          if (sql.includes("FROM source_capabilities")) return { results: [{
            id: "capability-event-unit-test", source_id: "source-event-unit-test",
            created_by_subject: "creator|opaque", status: "pending",
          }] };
          if (sql.includes("FROM tenant_source_reviewers")) return { results: reviewer ? [{ allowed: 1 }] : [] };
          if (sql.includes("FROM source_capability_event_requests")) return { results: state.request ? [state.request] : [] };
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
        request_sha256: args[6], event_id: args[7], request_id: args[9],
        response_json: args[10],
      };
      return statements.map((_, index) => ({ success: true, meta: { changes: reviewer && index === 0 ? 2 : 1 } }));
    },
  };
  return { db, state };
}

const common = {
  principalSubject: "creator|opaque",
  tenantId: "tenant-event-test",
  siteId: "site-event-test",
  capabilityId: "capability-event-unit-test",
  idempotencyKey: "event-idempotency-key",
  requestId: "event-request-id",
  eventType: "submitted",
  evidenceRef: "fixture:submission",
  cryptoProvider: { subtle: webcrypto.subtle, randomUUID },
};

test("records a creator submission with event, audit and idempotency in one batch", async () => {
  const { db, state } = fixtureDb();
  const result = await recordSourceCapabilityEvent({ ...common, db });
  assert.equal(result.replayed, false);
  assert.equal(result.event_type, "submitted");
  assert.equal(result.status, "pending");
  assert.equal(state.batches, 1);
});

test("exact lifecycle event retry replays without a second write", async () => {
  const { db, state } = fixtureDb();
  const first = await recordSourceCapabilityEvent({ ...common, db });
  const second = await recordSourceCapabilityEvent({ ...common, db });
  assert.equal(second.replayed, true);
  assert.equal(second.event_id, first.event_id);
  assert.equal(state.batches, 1);
});

test("same event key with changed evidence conflicts", async () => {
  const { db, state } = fixtureDb();
  await recordSourceCapabilityEvent({ ...common, db });
  await assert.rejects(
    recordSourceCapabilityEvent({ ...common, db, evidenceRef: "fixture:changed" }),
    /source_capability_event_idempotency_conflict/,
  );
  assert.equal(state.batches, 1);
});

test("only an assigned independent reviewer may submit terminal decisions", async () => {
  const { db, state } = fixtureDb();
  await assert.rejects(
    recordSourceCapabilityEvent({
      ...common, db, eventType: "approved", evidenceRef: "fixture:approval",
      principalSubject: "not-assigned-reviewer",
    }),
    /source_capability_review_denied/,
  );
  assert.equal(state.batches, 0);
});

test("reviewer approval is accepted by the persistence contract when assigned", async () => {
  const { db, state } = fixtureDb({ reviewer: true });
  const result = await recordSourceCapabilityEvent({
    ...common, db, eventType: "approved", evidenceRef: "fixture:approval",
    principalSubject: "reviewer|opaque",
  });
  assert.equal(result.event_type, "approved");
  assert.equal(result.status, "approved");
  assert.equal(state.batches, 1);
});

test("review rejection preserves a bounded reason and terminal status", async () => {
  const { db, state } = fixtureDb({ reviewer: true });
  const result = await recordSourceCapabilityEvent({
    ...common, db, eventType: "rejected", evidenceRef: "fixture:rejection",
    reason: "Source contract evidence is incomplete",
    principalSubject: "reviewer|opaque",
  });
  assert.equal(result.event_type, "rejected");
  assert.equal(result.status, "rejected");
  assert.equal(state.batches, 1);
});
