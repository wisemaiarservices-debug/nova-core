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

run("create submitted capability event and matching audit/idempotency rows", [
  "INSERT INTO source_capabilities",
  "(id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,quantity_semantics,",
  "acquisition_protocol,protocol_version,sampling_mode,interval_seconds,max_age_seconds,max_future_skew_seconds,",
  "timezone,allowed_quality_flags_json,calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,",
  "version,status,created_by_subject)",
  "VALUES('capability-http-event-idempotency','tenant-http-a','site-http-a','source-http-a',NULL,'neoagro',",
  "'event_idempotency_ec','dS/m','measured','CI lifecycle event idempotency metric','manual-lab','1.0','interval',",
  "3600,86400,300,'Africa/Tunis','[]',0,NULL,'source-rights:ci-http-a','source-evidence:ci-http-a',",
  "1,'pending','ci-human-subject');",
  "INSERT INTO source_capability_events",
  "(id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)",
  "VALUES('event-http-capability-submitted','capability-http-event-idempotency','tenant-http-a','site-http-a',",
  "'source-http-a','ci-human-subject','submitted','fixture:submission',NULL,'req-capability-submitted');",
  "INSERT INTO audit_events",
  "(id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json)",
  "VALUES('audit-http-capability-submitted','tenant-http-a','operator','ci-human-subject',",
  "'source_capability.submitted','source_capability','capability-http-event-idempotency',",
  "'2026-11-21T12:00:00.000Z','req-capability-submitted','{\"event_type\":\"submitted\"}');",
  "INSERT INTO source_capability_event_requests",
  "(id,tenant_id,site_id,capability_id,actor_subject,idempotency_key,request_sha256,event_id,event_type,request_id,response_json)",
  "VALUES('request-http-capability-submitted','tenant-http-a','site-http-a','capability-http-event-idempotency',",
  "'ci-human-subject','ci-capability-event-key',",
  "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',",
  "'event-http-capability-submitted','submitted','req-capability-submitted',",
  "'{\"event_type\":\"submitted\",\"status\":\"pending\"}');"
].join("\n"));

reject("duplicate scoped lifecycle-event idempotency key",
  "INSERT INTO source_capability_event_requests " +
  "(id,tenant_id,site_id,capability_id,actor_subject,idempotency_key,request_sha256,event_id,event_type,request_id,response_json) " +
  "VALUES('request-http-capability-event-duplicate','tenant-http-a','site-http-a','capability-http-event-idempotency'," +
  "'ci-human-subject','ci-capability-event-key','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'," +
  "'event-http-capability-submitted','submitted','req-capability-event-duplicate','{}')");

reject("event request cannot be attached to another tenant",
  "INSERT INTO source_capability_event_requests " +
  "(id,tenant_id,site_id,capability_id,actor_subject,idempotency_key,request_sha256,event_id,event_type,request_id,response_json) " +
  "VALUES('request-http-capability-event-cross-tenant','tenant-http-b','site-http-b','capability-http-event-idempotency'," +
  "'ci-tenant-b-owner','ci-capability-event-cross-tenant','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'," +
  "'event-http-capability-submitted','submitted','req-capability-event-cross-tenant','{}')");

reject("event request requires its matching audit record",
  "INSERT INTO source_capability_event_requests " +
  "(id,tenant_id,site_id,capability_id,actor_subject,idempotency_key,request_sha256,event_id,event_type,request_id,response_json) " +
  "VALUES('request-http-capability-event-no-audit','tenant-http-a','site-http-a','capability-http-event-idempotency'," +
  "'ci-human-subject','ci-capability-event-no-audit','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'," +
  "'event-http-capability-submitted','submitted','req-capability-event-no-audit','{}')");

reject("event request digest must be lowercase SHA-256",
  "INSERT INTO source_capability_event_requests " +
  "(id,tenant_id,site_id,capability_id,actor_subject,idempotency_key,request_sha256,event_id,event_type,request_id,response_json) " +
  "VALUES('request-http-capability-event-bad-digest','tenant-http-a','site-http-a','capability-http-event-idempotency'," +
  "'ci-human-subject','ci-capability-event-bad-digest','NOT_A_SHA256_DIGEST'," +
  "'event-http-capability-submitted','submitted','req-capability-event-bad-digest','{}')");

reject("event request records cannot be updated",
  "UPDATE source_capability_event_requests SET response_json='{}' WHERE id='request-http-capability-submitted'");
reject("event request records cannot be deleted",
  "DELETE FROM source_capability_event_requests WHERE id='request-http-capability-submitted'");

console.log("Source capability event idempotency D1 tests passed");
