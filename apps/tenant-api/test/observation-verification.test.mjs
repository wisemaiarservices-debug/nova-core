import test from "node:test";
import assert from "node:assert/strict";
import { assignObservationReviewer, reviewObservation } from "../src/observation-verification.mjs";

const observation = { id: "obs-1", tenant_id: "tenant-a", site_id: "site-a", verification_status: "unverified" };
function database({ site = true, assignment = true, audit = true, membership = true, status = "unverified", actorId = "ingestion-service", batchChanges = [1, 1] } = {}) {
  const state = { calls: [], batches: [], batchChanges };
  return {
    state,
    prepare(sql) {
      return { sql, args: [], bind(...args) { this.args = args; return this; },
        async all() {
          state.calls.push({ sql, args: this.args });
          if (sql.includes("FROM tenant_memberships")) return { results: membership ? [{ subject: reviewer, tenant_id: "tenant-a", membership_status: "active", tenant_status: "active" }] : [] };
          if (sql.includes("FROM sites")) return { results: site ? [{ id: "site-a" }] : [] };
          if (sql.includes("FROM observations WHERE tenant_id")) return { results: [{ ...observation, verification_status: status }] };
          if (sql.includes("FROM observation_reviewers")) return { results: assignment ? [
            { reviewer_subject: "reviewer@example.test", reviewer_role: "measurement_reviewer" },
          ] : [] };
          if (sql.includes("FROM audit_events")) return { results: audit ? [
            { actor_type: "service", actor_id: actorId },
          ] : [] };
          throw new Error("unexpected SQL: " + sql);
        },
      };
    },
    async batch(statements) {
      state.batches.push(statements);
      return statements.map((_, i) => ({ meta: { changes: batchChanges[i] ?? 0 } }));
    },
  };
}
const reviewer = "reviewer@example.test";

test("assigns a site-scoped measurement reviewer and writes an append-only event atomically", async () => {
  const db = database();
  const result = await assignObservationReviewer(db, "tenant-a", "owner@example.test", "req-1", {
    site_id: "site-a", reviewer_subject: reviewer, evidence_ref: "appointment:123",
  }, "assign");
  assert.equal(result.status, 201);
  assert.equal(result.data.status, "active");
  assert.equal(db.state.batches.length, 1);
  assert.equal(db.state.batches[0].length, 2);
  assert.match(db.state.batches[0][0].sql, /INSERT INTO observation_reviewers/);
  assert.match(db.state.batches[0][1].sql, /INSERT INTO observation_reviewer_events/);
});

test("requires an active tenant membership before reviewer assignment", async () => {
  const result = await assignObservationReviewer(database({ membership: false }), "tenant-a",
    "owner@example.test", "req-membership", {
      site_id: "site-a", reviewer_subject: reviewer, evidence_ref: "appointment:123",
    }, "assign");
  assert.equal(result.error, "observation_reviewer_membership_not_active");
});

test("rejects self-assignment and unknown request fields", async () => {
  const db = database();
  const self = await assignObservationReviewer(db, "tenant-a", reviewer, "req-1", {
    site_id: "site-a", reviewer_subject: reviewer, evidence_ref: "appointment:123",
  }, "assign");
  assert.equal(self.status, 400);
  const extra = await assignObservationReviewer(db, "tenant-a", "owner@example.test", "req-2", {
    site_id: "site-a", reviewer_subject: reviewer, evidence_ref: "appointment:123", role: "owner",
  }, "assign");
  assert.equal(extra.status, 400);
  assert.equal(db.state.batches.length, 0);
});

test("verifies only a tenant-scoped observation with an active independent reviewer and service-ingestion audit", async () => {
  const db = database();
  const result = await reviewObservation(db, "tenant-a", "obs-1", reviewer, "req-2", {
    decision: "verify", evidence_ref: "inspection:field-check-1",
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.verification_status, "verified");
  assert.equal(db.state.batches.length, 1);
  assert.equal(db.state.batches[0].length, 2);
  assert.match(db.state.batches[0][0].sql, /INSERT INTO observation_verification_events/);
  assert.match(db.state.batches[0][1].sql, /verification_status = \\?/);
  assert.deepEqual(db.state.calls.find(x => x.sql.includes("FROM audit_events")).args, ["tenant-a", "obs-1"]);
});

test("rejects missing reviewer assignment, missing ingestion provenance, and self-review", async () => {
  const unassigned = await reviewObservation(database({ assignment: false }), "tenant-a", "obs-1", reviewer, "req-3", {
    decision: "verify", evidence_ref: "inspection:1",
  });
  assert.equal(unassigned.error, "observation_reviewer_assignment_not_found");
  const missingAudit = await reviewObservation(database({ audit: false }), "tenant-a", "obs-1", reviewer, "req-4", {
    decision: "verify", evidence_ref: "inspection:1",
  });
  assert.equal(missingAudit.error, "observation_submitter_independence_not_established");
  const self = await reviewObservation(database({ actorId: reviewer }), "tenant-a", "obs-1", reviewer, "req-5", {
    decision: "verify", evidence_ref: "inspection:1",
  });
  assert.equal(self.error, "observation_submitter_independence_not_established");
});

test("rejects invalid and stale state transitions without writing", async () => {
  const db = database({ status: "rejected" });
  const conflict = await reviewObservation(db, "tenant-a", "obs-1", reviewer, "req-6", {
    decision: "verify", evidence_ref: "inspection:1",
  });
  assert.equal(conflict.error, "observation_verification_state_conflict");
  assert.equal(db.state.batches.length, 0);
  const invalid = await reviewObservation(database(), "tenant-a", "obs-1", reviewer, "req-7", {
    decision: "approve", evidence_ref: "inspection:1",
  });
  assert.equal(invalid.status, 400);
});

test("requires reasons for rejection and revocation and fails on concurrent transition conflicts", async () => {
  const invalid = await reviewObservation(database(), "tenant-a", "obs-1", reviewer, "req-8", {
    decision: "reject", evidence_ref: "inspection:1",
  });
  assert.equal(invalid.status, 400);
  const conflictDb = database({ batchChanges: [0, 0] });
  const conflict = await reviewObservation(conflictDb, "tenant-a", "obs-1", reviewer, "req-9", {
    decision: "verify", evidence_ref: "inspection:1",
  });
  assert.equal(conflict.status, 409);
});

test("revokes an existing verification back to unverified with an auditable reason", async () => {
  const db = database({ status: "verified" });
  const result = await reviewObservation(db, "tenant-a", "obs-1", reviewer, "req-10", {
    decision: "revoke", evidence_ref: "recheck:2", reason: "Original inspection record withdrawn",
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.verification_status, "unverified");
  assert.deepEqual(db.state.batches[0][1].args, ["unverified", "obs-1", "tenant-a", "site-a", "verified", db.state.batches[0][0].args[0], "revoked"]);
});
