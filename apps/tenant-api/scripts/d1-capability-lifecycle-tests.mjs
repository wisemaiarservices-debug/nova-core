import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const args = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];
function expectRejected(label, sql) {
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
  assert.notEqual(result.status, 0,
    label + " unexpectedly succeeded\n" + (result.stdout || "") + "\n" + (result.stderr || ""));
  console.log("Rejected as expected: " + label);
}

const event = (id, tenant, actor, type, reason, request) =>
  "INSERT INTO source_capability_events " +
  "(id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id) VALUES (" +
  "'" + id + "','capability-http-a','" + tenant + "','site-http-a','source-http-a','" +
  actor + "','" + type + "','fixture:negative-test'," +
  (reason === null ? "NULL" : "'" + reason + "'") + ",'" + request + "')";

expectRejected("creator cannot self-approve",
  event("capability-self-approval", "tenant-http-a", "ci-human-subject", "rejected",
    "self review must fail", "ci-capability-self-approval"));
expectRejected("active but unassigned member cannot approve",
  event("capability-unassigned-review", "tenant-http-a", "ci-lifecycle-member", "rejected",
    "unassigned review must fail", "ci-capability-unassigned-review"));
expectRejected("cross-tenant event scope mismatch",
  event("capability-cross-tenant-event", "tenant-http-b", "ci-measurement-reviewer", "revoked",
    "cross-tenant event must fail", "ci-capability-cross-tenant-event"));
expectRejected("duplicate terminal event",
  event("capability-duplicate-approval", "tenant-http-a", "ci-measurement-reviewer", "approved",
    null, "ci-capability-duplicate-approval"));
expectRejected("invalid status rollback",
  "UPDATE source_capabilities SET status='pending' WHERE id='capability-http-a'");
expectRejected("capability definition mutation",
  "UPDATE source_capabilities SET quantity_semantics='tampered' WHERE id='capability-http-a'");
expectRejected("capability deletion",
  "DELETE FROM source_capabilities WHERE id='capability-http-a'");
expectRejected("event mutation",
  "UPDATE source_capability_events SET evidence_ref='tampered' WHERE id='capability-http-a-approved'");
expectRejected("event deletion",
  "DELETE FROM source_capability_events WHERE id='capability-http-a-approved'");

console.log("Source capability lifecycle negative D1 tests passed");
