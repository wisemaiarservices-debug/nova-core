import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const args = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];

function run(label, sql, shouldPass) {
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
  const output = (result.stdout || "") + "\n" + (result.stderr || "");
  if (shouldPass) {
    assert.equal(result.status, 0, label + " failed\n" + output);
  } else {
    assert.notEqual(result.status, 0, label + " unexpectedly succeeded\n" + output);
    assert.match(output, /observation requires exactly one current approved capability and valid calibration evidence/,
      label + " failed for an unexpected reason\n" + output);
  }
  console.log((shouldPass ? "Passed: " : "Rejected as expected: ") + label);
}

run("register a second independently approved version with overlapping scope", `
  INSERT INTO source_capabilities
  (id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,
   quantity_semantics,acquisition_protocol,protocol_version,sampling_mode,interval_seconds,
   max_age_seconds,max_future_skew_seconds,timezone,allowed_quality_flags_json,
   calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,version,status,
   created_by_subject)
  VALUES
  ('capability-http-grant-v2','tenant-http-a','site-http-a','source-http-grant','asset-http-grant',
   'neoagro','soil_moisture','m3/m3','measured','CI overlapping version fixture',
   'manual-lab','1.0','interval',3600,31536000,300,'Africa/Tunis','[]',
   0,NULL,'source-rights:ci-http-grant-asset','source-evidence:ci-http-grant-asset',2,'pending','ci-human-subject');
  INSERT INTO source_capability_events
  (id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
  VALUES
  ('capability-http-grant-v2-submitted','capability-http-grant-v2','tenant-http-a','site-http-a',
   'source-http-grant','ci-human-subject','submitted','fixture:capability-submission-v2',NULL,
   'ci-capability-v2-submit');
  INSERT INTO source_capability_events
  (id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
  VALUES
  ('capability-http-grant-v2-approved','capability-http-grant-v2','tenant-http-a','site-http-a',
   'source-http-grant','ci-measurement-reviewer','approved','fixture:capability-review-v2',NULL,
   'ci-capability-v2-approve');
`, true);

run("deny observation when two approved capability versions overlap", `
  INSERT INTO observations
  (id,site_id,tenant_id,asset_id,source_id,module,metric,value,unit,observed_at,
   idempotency_key,verification_status,provenance_json,quality_flags_json,
   source_capability_id,measurement_kind,acquisition_protocol,protocol_version,
   sampling_mode,sampling_interval_seconds)
  VALUES
  ('obs-capability-overlap-denied','site-http-a','tenant-http-a','asset-http-grant',
   'source-http-grant','neoagro','soil_moisture',0.25,'m3/m3',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'),'ci-capability-overlap-denied',
   'unverified','{}','[]','capability-http-grant','measured','manual-lab','1.0',
   'interval',3600);
`, false);

console.log("Overlapping approved capability D1 tests passed");
