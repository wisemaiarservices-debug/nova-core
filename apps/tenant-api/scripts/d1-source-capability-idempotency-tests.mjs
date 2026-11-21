import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const args = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];
function run(label, sql) {
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
  assert.equal(result.status, 0,
    label + " failed\n" + (result.stdout || "") + "\n" + (result.stderr || ""));
}
function reject(label, sql) {
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
  assert.notEqual(result.status, 0,
    label + " unexpectedly succeeded\n" + (result.stdout || "") + "\n" + (result.stderr || ""));
  console.log("Rejected as expected: " + label);
}

run("create pending capability with immutable audit and idempotency record", [
  "INSERT INTO source_capabilities",
  "(id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,quantity_semantics,",
  "acquisition_protocol,protocol_version,sampling_mode,interval_seconds,max_age_seconds,max_future_skew_seconds,",
  "timezone,allowed_quality_flags_json,calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,",
  "version,status,created_by_subject)",
  "VALUES('capability-http-idempotency','tenant-http-a','site-http-a','source-http-a',NULL,'neoagro',",
  "'ec_idempotency_test','dS/m','measured','CI idempotency metric','manual-lab','1.0','interval',3600,",
  "31536000,300,'Africa/Tunis','[]',0,NULL,'fixture:data-rights','fixture:capability-evidence',",
  "1,'pending','ci-human-subject');",
  "INSERT INTO audit_events",
  "(id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json)",
  "VALUES('audit-http-capability-idempotency','tenant-http-a','operator','ci-human-subject',",
  "'source_capability.created','source_capability','capability-http-idempotency',",
  "'2026-11-21T12:00:00.000Z','req-capability-idempotency',",
  "'{\"capability_id\":\"capability-http-idempotency\"}');",
  "INSERT INTO source_capability_creation_requests",
  "(id,tenant_id,site_id,actor_subject,idempotency_key,request_sha256,capability_id,request_id,response_json)",
  "VALUES('request-http-capability-idempotency','tenant-http-a','site-http-a','ci-human-subject',",
  "'ci-capability-idempotency-key','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',",
  "'capability-http-idempotency','req-capability-idempotency',",
  "'{\"capability_id\":\"capability-http-idempotency\",\"status\":\"pending\"}');"
].join("\n"));

reject("duplicate scoped idempotency key",
  "INSERT INTO source_capability_creation_requests " +
  "(id,tenant_id,site_id,actor_subject,idempotency_key,request_sha256,capability_id,request_id,response_json) " +
  "VALUES('request-http-capability-duplicate','tenant-http-a','site-http-a','ci-human-subject'," +
  "'ci-capability-idempotency-key','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'," +
  "'capability-http-idempotency','req-capability-idempotency-duplicate','{}')");

reject("request record cannot be attached to another tenant capability",
  "INSERT INTO source_capability_creation_requests " +
  "(id,tenant_id,site_id,actor_subject,idempotency_key,request_sha256,capability_id,request_id,response_json) " +
  "VALUES('request-http-capability-cross-tenant','tenant-http-b','site-http-b','ci-tenant-b-owner'," +
  "'ci-capability-cross-tenant-key','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'," +
  "'capability-http-idempotency','req-capability-cross-tenant','{}')");

reject("request record requires matching creation audit",
  "INSERT INTO source_capability_creation_requests " +
  "(id,tenant_id,site_id,actor_subject,idempotency_key,request_sha256,capability_id,request_id,response_json) " +
  "VALUES('request-http-capability-without-audit','tenant-http-a','site-http-a','ci-human-subject'," +
  "'ci-capability-no-audit-key','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'," +
  "'capability-http-a','req-capability-no-audit','{}')");

reject("request digest must be lowercase SHA-256",
  "INSERT INTO source_capability_creation_requests " +
  "(id,tenant_id,site_id,actor_subject,idempotency_key,request_sha256,capability_id,request_id,response_json) " +
  "VALUES('request-http-capability-bad-digest','tenant-http-a','site-http-a','ci-human-subject'," +
  "'ci-capability-bad-digest-key','NOT_A_SHA256_DIGEST','capability-http-idempotency'," +
  "'req-capability-bad-digest','{}')");

reject("creation request records are immutable",
  "UPDATE source_capability_creation_requests SET response_json='{}' " +
  "WHERE id='request-http-capability-idempotency'");

reject("creation request records cannot be deleted",
  "DELETE FROM source_capability_creation_requests WHERE id='request-http-capability-idempotency'");

console.log("Source capability creation idempotency D1 tests passed");
