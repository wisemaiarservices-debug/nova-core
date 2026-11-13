import test from "node:test";
import assert from "node:assert/strict";
import { reviewSiteConfiguration } from "../src/configuration-review-persistence.mjs";

const input = { principalSubject: "reviewer", tenantId: "tenant-a", siteId: "site-a",
  version: "v1", decision: "approve", reason: "Reviewed against the submitted site evidence",
  requestId: "review-request-1" };

function database({ role = "tenant_admin", active = true, grant = true,
  creator = "author", latest = "submitted_for_review", assignment = true, ambiguousAssignment = false, batchFailure = false } = {}) {
  const calls = [], batches = [];
  return { calls, batches,
    prepare(sql) { return { bind(...args) { return { sql, args, async all() {
      calls.push({ sql, args });
      if (sql.includes("tenant_memberships")) return { results: active ? [{
        subject: "reviewer", tenant_id: "tenant-a", role,
        membership_status: "active", tenant_status: "active",
      }] : [] };
      if (sql.includes("tenant_resource_grants")) return { results: grant ? [{
        subject: "reviewer", tenant_id: "tenant-a", resource_type: "site",
        resource_id: "site-a", action: "update",
      }] : [] };
      if (sql.includes("tenant_site_configurations")) return { results: [{
        id: "configuration-1", created_by_subject: creator, configuration_version: "v1",
      }] };
      if (sql.includes("tenant_site_configuration_reviewers")) return { results: assignment ? [
        { reviewer_role: "engineering_reviewer" },
        ...(ambiguousAssignment ? [{ reviewer_role: "operations_reviewer" }] : []),
      ] : [] };
      if (sql.includes("tenant_site_configuration_events")) return { results: [{ event_type: latest }] };
      throw new Error("unexpected SQL");
    } }; } }; },
    async batch(statements) {
      batches.push(statements);
      if (batchFailure) throw new Error("simulated_batch_failure");
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
}

test("records an independent admin approval and audit event atomically", async () => {
  const db = database();
  const result = await reviewSiteConfiguration({ db, ...input });
  assert.equal(result.status, "approved_for_review");
  assert.equal(result.reviewed_by_subject, "reviewer");\n  assert.equal(result.reviewer_role, "engineering_reviewer");
  assert.equal(result.operational_decision, "not_authorized");
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 2);
  assert.equal(db.batches[0][0].args[4], "approved_for_review");
  assert.equal(db.batches[0][1].args[3], "configuration.approved_for_review");
});

test("records rejection using the same lifecycle and audit transaction", async () => {
  const db = database();
  const result = await reviewSiteConfiguration({ db, ...input, decision: "reject",
    reason: "The boundary evidence is incomplete" });
  assert.equal(result.status, "rejected");
  assert.match(db.batches[0][0].sql, /event_type/);
  assert.equal(db.batches[0][0].args[4], "rejected");
  assert.equal(db.batches[0][1].args[3], "configuration.rejected");
});

test("denies creator self-review, non-admin reviewers, missing grants and inactive tenants", async () => {
  for (const options of [
    { creator: "reviewer" }, { role: "operator" }, { grant: false }, { active: false },\n    { assignment: false }, { ambiguousAssignment: true },
  ]) {
    const db = database(options);
    await assert.rejects(() => reviewSiteConfiguration({ db, ...input }));
    assert.equal(db.batches.length, 0);
  }
});

test("only submitted configurations can be reviewed", async () => {
  const db = database({ latest: "approved_for_review" });
  await assert.rejects(() => reviewSiteConfiguration({ db, ...input }), /configuration_review_state_conflict/);
  assert.equal(db.batches.length, 0);
});

test("requires a bounded reason and a supported decision", async () => {
  const db = database();
  await assert.rejects(() => reviewSiteConfiguration({ db, ...input, reason: "no" }),
    /configuration_review_request_invalid/);
  await assert.rejects(() => reviewSiteConfiguration({ db, ...input, decision: "withdraw" }),
    /configuration_review_request_invalid/);
  assert.equal(db.batches.length, 0);
});

test("does not report success when the audit/event batch fails", async () => {
  const db = database({ batchFailure: true });
  await assert.rejects(() => reviewSiteConfiguration({ db, ...input }), /simulated_batch_failure/);
  assert.equal(db.batches.length, 1);
});
