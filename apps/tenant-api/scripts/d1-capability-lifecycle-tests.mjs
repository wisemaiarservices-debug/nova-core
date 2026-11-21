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

// A reviewer assignment is retained after revocation, but must no longer
// authorize a capability lifecycle decision. Use an isolated reviewer identity
// and a fresh capability so this regression does not disturb other fixtures.
function runSql(label, sql) {
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
  assert.equal(result.status, 0,
    label + " failed\n" + (result.stdout || "") + "\n" + (result.stderr || ""));
  console.log("Applied local D1 setup: " + label);
}

runSql("prepare capability and dedicated reviewer revocation fixture", [
  "INSERT INTO tenant_memberships(id,tenant_id,subject,role,status) VALUES",
  "('membership-http-cap-reviewer-revoked','tenant-http-a','ci-capability-reviewer-revoked','viewer','active');",
  "INSERT INTO tenant_source_reviewers(tenant_id,site_id,reviewer_subject,status,assigned_by_subject,evidence_ref) VALUES",
  "('tenant-http-a','site-http-a','ci-capability-reviewer-revoked','active','ci-human-subject','fixture:capability-reviewer-revocation');",
  "INSERT INTO tenant_source_reviewer_events(id,tenant_id,site_id,reviewer_subject,actor_subject,event_type,evidence_ref,request_id) VALUES",
  "('cap-reviewer-revoked-assigned','tenant-http-a','site-http-a','ci-capability-reviewer-revoked','ci-human-subject','assigned','fixture:capability-reviewer-revocation','ci-cap-reviewer-assigned');",
  "INSERT INTO source_capabilities",
  "(id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,quantity_semantics,acquisition_protocol,protocol_version,sampling_mode,interval_seconds,max_age_seconds,max_future_skew_seconds,timezone,allowed_quality_flags_json,calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,version,status,created_by_subject)",
  "VALUES('capability-http-reviewer-revoked','tenant-http-a','site-http-a','source-http-a',NULL,'neoagro','ec','dS/m','measured','Electrical conductivity of irrigation water','manual-lab','1.0','interval',3600,31536000,300,'Africa/Tunis','[]',0,NULL,'fixture:data-rights','fixture:capability-evidence',2,'pending','ci-human-subject');",
  "INSERT INTO source_capability_events(id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id) VALUES",
  "('capability-http-reviewer-revoked-submitted','capability-http-reviewer-revoked','tenant-http-a','site-http-a','source-http-a','ci-human-subject','submitted','fixture:capability-submission',NULL,'ci-cap-reviewer-capability-submit');",
  "UPDATE tenant_source_reviewers SET status='revoked' WHERE tenant_id='tenant-http-a' AND site_id='site-http-a' AND reviewer_subject='ci-capability-reviewer-revoked' AND status='active';",
  "INSERT INTO tenant_source_reviewer_events(id,tenant_id,site_id,reviewer_subject,actor_subject,event_type,evidence_ref,reason,request_id) VALUES",
  "('cap-reviewer-revoked-event','tenant-http-a','site-http-a','ci-capability-reviewer-revoked','ci-human-subject','revoked','fixture:capability-reviewer-revocation','reviewer assignment revoked for CI regression','ci-cap-reviewer-revoked');"
].join("\n"));

expectRejected("revoked reviewer assignment cannot approve capability",
  "INSERT INTO source_capability_events " +
  "(id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id) VALUES " +
  "('capability-reviewer-revoked-approval','capability-http-reviewer-revoked','tenant-http-a','site-http-a','source-http-a'," +
  "'ci-capability-reviewer-revoked','approved','fixture:negative-test',NULL,'ci-cap-reviewer-revoked-approval')");

console.log("Source capability lifecycle negative D1 tests passed");
