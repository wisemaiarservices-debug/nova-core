import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const args = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];
function execute(label, sql) {
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
  const output = (result.stdout || "") + "\n" + (result.stderr || "");
  assert.equal(result.status, 0, label + " failed\n" + output);
  console.log("Passed: " + label);
}
function expectRejected(label, sql) {
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
  const output = (result.stdout || "") + "\n" + (result.stderr || "");
  assert.notEqual(result.status, 0, label + " unexpectedly succeeded\n" + output);
  assert.match(output, /observation requires exactly one current approved capability and valid calibration evidence/,
    label + " failed for an unexpected reason\n" + output);
  console.log("Rejected as expected: " + label);
}

function observation(id, key, capability, extra = {}) {
  const values = {
    asset: "NULL",
    protocol: "manual-lab",
    version: "1.0",
    kind: "measured",
    mode: "'interval'",
    interval: "3600",
    flags: "'[]'",
    observed: "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    ...extra,
  };
  const capabilityValue = capability === null ? "NULL" : "'" + capability + "'";
  return `INSERT INTO observations
    (id,site_id,tenant_id,asset_id,source_id,module,metric,value,unit,observed_at,
     idempotency_key,verification_status,provenance_json,quality_flags_json,
     source_capability_id,measurement_kind,acquisition_protocol,protocol_version,
     sampling_mode,sampling_interval_seconds)
    VALUES ('${id}','site-http-a','tenant-http-a',${values.asset},'${values.source || "source-http-grant"}',
      'neoagro','${values.metric || "ec"}',1.5,'${values.unit || "dS/m"}',${values.observed},
      '${key}','unverified','{}',${values.flags},${capabilityValue},'${values.kind}',
      '${values.protocol}','${values.version}',${values.mode},${values.interval})`;
}



execute("seed isolated observation capability guard source and calibration fixtures", `
  INSERT INTO sensor_source_identity_mappings
  (id,tenant_id,site_id,asset_id,source_id,sensor_id,parameter,unit,effective_from,effective_to,
   mapping_method,evidence_ref,registered_by_subject)
  VALUES ('mapping-http-guard','tenant-http-a','site-http-a','asset-http-grant','source-http-grant',
    'sensor-http-guard','ec','dS/m','2026-01-01T00:00:00Z',NULL,
    'CI exact capability guard mapping','fixture:mapping-http-guard','ci-human-subject');
  INSERT INTO sensor_source_mapping_events
  (id,tenant_id,site_id,asset_id,source_id,mapping_id,reviewer_subject,event_type,evidence_ref,reason,request_id)
  VALUES ('mapping-http-guard-verified','tenant-http-a','site-http-a','asset-http-grant','source-http-grant',
    'mapping-http-guard','ci-measurement-reviewer','verified','fixture:mapping-http-guard-review',NULL,
    'ci-mapping-http-guard-verified');
  INSERT INTO source_calibration_profiles
  (profile_ref,tenant_id,site_id,asset_id,source_id,mapping_id,parameter,unit,evidence_ref,created_by_subject)
  VALUES ('profile-http-guard','tenant-http-a','site-http-a','asset-http-grant','source-http-grant',
    'mapping-http-guard','ec','dS/m','fixture:profile-http-guard','ci-human-subject');
  INSERT INTO sensor_calibrations
  (id,tenant_id,site_id,asset_id,sensor_id,parameter,unit,calibration_method,calibrated_at,valid_until,
   laboratory_name,certificate_evidence_id,reference_value,as_found_value,as_left_value,uncertainty,
   notes,registered_by_subject)
  VALUES ('cal-http-guard','tenant-http-a','site-http-a','asset-http-grant','sensor-http-guard',
    'ec','dS/m','CI guard reference method','2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',
    'CI fixture laboratory','lab-http-calibration',1.5,1.6,1.5,0.01,
    'Synthetic CI fixture only','ci-human-subject');
  INSERT INTO sensor_calibration_events
  (id,calibration_id,tenant_id,site_id,event_type,actor_subject,request_id)
  VALUES ('cal-http-guard-registered','cal-http-guard','tenant-http-a','site-http-a','registered',
    'ci-human-subject','ci-calibration-http-guard-registration');
  INSERT INTO sensor_calibration_verification_events
  (id,tenant_id,site_id,asset_id,calibration_id,reviewer_subject,reviewer_role,event_type,evidence_ref,reason,request_id)
  VALUES ('cal-http-guard-verified','tenant-http-a','site-http-a','asset-http-grant','cal-http-guard',
    'ci-measurement-reviewer','calibration_reviewer','verified','lab-http-calibration',NULL,
    'ci-calibration-http-guard-verified');
  INSERT INTO source_capabilities
  (id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,
   quantity_semantics,acquisition_protocol,protocol_version,sampling_mode,interval_seconds,
   max_age_seconds,max_future_skew_seconds,timezone,allowed_quality_flags_json,
   calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,version,status,created_by_subject)
  VALUES ('capability-http-guard-site','tenant-http-a','site-http-a','source-http-grant',NULL,
    'neoagro','ec','dS/m','measured','CI site capability guard','manual-lab','1.0','interval',3600,
    31536000,300,'Africa/Tunis','[]',0,NULL,'fixture:rights','fixture:capability',1,'pending','ci-human-subject');
  INSERT INTO source_capability_events
  (id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
  VALUES ('capability-http-guard-site-submitted','capability-http-guard-site','tenant-http-a','site-http-a',
    'source-http-grant','ci-human-subject','submitted','fixture:capability-submit',NULL,'ci-guard-site-submit');
  INSERT INTO source_capability_events
  (id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
  VALUES ('capability-http-guard-site-approved','capability-http-guard-site','tenant-http-a','site-http-a',
    'source-http-grant','ci-measurement-reviewer','approved','fixture:capability-approve',NULL,'ci-guard-site-approve');
  INSERT INTO source_capabilities
  (id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,
   quantity_semantics,acquisition_protocol,protocol_version,sampling_mode,interval_seconds,
   max_age_seconds,max_future_skew_seconds,timezone,allowed_quality_flags_json,
   calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,version,status,created_by_subject)
  VALUES ('capability-http-guard-cal','tenant-http-a','site-http-a','source-http-grant','asset-http-grant',
    'neoagro','ec','dS/m','measured','CI calibrated asset capability guard','manual-lab','1.0','interval',3600,
    31536000,300,'Africa/Tunis','[]',1,'profile-http-guard','fixture:rights','fixture:capability',1,'pending','ci-human-subject');
  INSERT INTO source_capability_events
  (id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
  VALUES ('capability-http-guard-cal-submitted','capability-http-guard-cal','tenant-http-a','site-http-a',
    'source-http-grant','ci-human-subject','submitted','fixture:capability-submit',NULL,'ci-guard-cal-submit');
  INSERT INTO source_capability_events
  (id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
  VALUES ('capability-http-guard-cal-approved','capability-http-guard-cal','tenant-http-a','site-http-a',
    'source-http-grant','ci-measurement-reviewer','approved','fixture:capability-approve',NULL,'ci-guard-cal-approve');
`);

const diagnostic = spawnSync("npx", [...args,
  "SELECT c.id,c.status,c.tenant_id,c.site_id,c.source_id,c.asset_id,c.module,c.metric,c.unit,c.measurement_kind,c.acquisition_protocol,c.protocol_version,c.sampling_mode,c.interval_seconds,c.max_age_seconds,c.max_future_skew_seconds,src.site_id AS source_site,src.verification_status,t.status AS tenant_status,s.status AS site_status,(SELECT e.event_type FROM source_capability_events e WHERE e.capability_id=c.id ORDER BY e.rowid DESC LIMIT 1) AS latest_event FROM source_capabilities c JOIN sources src ON src.id=c.source_id JOIN tenants t ON t.id=c.tenant_id JOIN sites s ON s.id=c.site_id WHERE c.id='capability-http-guard-site'"], { encoding: "utf8" });
assert.equal(diagnostic.status, 0, diagnostic.stderr || "capability diagnostic failed");
console.log("Capability fixture diagnostic: " + diagnostic.stdout);

execute("approved site capability accepts an exact current observation",
  observation("obs-capability-guard-positive","ci-capability-guard-positive","capability-http-guard-site"));

function expectUpdateRejected(label, sql, expectedMessage) {
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
  const output = (result.stdout || "") + "\\n" + (result.stderr || "");
  assert.notEqual(result.status, 0, label + " unexpectedly succeeded\\n" + output);
  assert.match(output, new RegExp(expectedMessage), label + " failed for an unexpected reason\\n" + output);
  console.log("Rejected as expected: " + label);
}

expectUpdateRejected("measurement value cannot be changed after insertion",
  "UPDATE observations SET value=99 WHERE id='obs-capability-guard-positive'",
  "observation measurement evidence is immutable");
expectUpdateRejected("capability identity cannot be changed after insertion",
  "UPDATE observations SET source_capability_id='capability-http-guard-cal' WHERE id='obs-capability-guard-positive'",
  "observation capability metadata is immutable");
expectUpdateRejected("measurement protocol metadata cannot be changed after insertion",
  "UPDATE observations SET acquisition_protocol='replacement-protocol' WHERE id='obs-capability-guard-positive'",
  "observation capability metadata is immutable");
execute("approved asset capability accepts an exact current observation",
  observation("obs-capability-guard-calibrated","ci-capability-guard-calibrated","capability-http-guard-cal",
    { asset: "'asset-http-grant'" }));

expectRejected("missing capability identity",
  observation("obs-capability-guard-no-id","ci-capability-guard-no-id",null));
expectRejected("protocol mismatch",
  observation("obs-capability-guard-protocol","ci-capability-guard-protocol","capability-http-guard-site",
    { protocol: "other-protocol" }));
expectRejected("disallowed quality flag",
  observation("obs-capability-guard-quality","ci-capability-guard-quality","capability-http-guard-site",
    { flags: "json_array('trusted')" }));
expectRejected("site capability cannot inherit to an asset",
  observation("obs-capability-guard-asset-scope","ci-capability-guard-asset-scope","capability-http-guard-site",
    { asset: "'asset-http-grant'" }));
expectRejected("stale observation is denied",
  observation("obs-capability-guard-stale","ci-capability-guard-stale","capability-http-guard-site",
    { observed: "strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 years')" }));
expectRejected("future observation outside approved skew is denied",
  observation("obs-capability-guard-future","ci-capability-guard-future","capability-http-guard-site",
    { observed: "strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day')" }));

execute("calibration revocation event is appended",
  `INSERT INTO sensor_calibration_verification_events
    (id,tenant_id,site_id,asset_id,calibration_id,reviewer_subject,reviewer_role,
     event_type,evidence_ref,reason,request_id)
    VALUES ('cal-http-guard-revoked-after-positive','tenant-http-a','site-http-a','asset-http-grant',
      'cal-http-guard','ci-measurement-reviewer','calibration_reviewer','revoked',
      'fixture:calibration-revocation', 'CI revocation test','ci-calibration-revoke-after-positive')`);
expectRejected("revoked calibration cannot authorize a new observation",
  observation("obs-capability-guard-revoked-cal","ci-capability-guard-revoked-cal","capability-http-guard-cal",
    { asset: "'asset-http-grant'" }));

execute("capability revocation event is appended",
  `INSERT INTO source_capability_events
    (id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
    VALUES ('capability-http-guard-site-revoked-ci','capability-http-guard-site','tenant-http-a','site-http-a','source-http-grant',
      'ci-measurement-reviewer','revoked','fixture:capability-revocation','CI revocation test',
      'ci-capability-guard-revoke-after-positive')`);
expectRejected("revoked capability cannot authorize a new observation",
  observation("obs-capability-guard-revoked-cap","ci-capability-guard-revoked-cap","capability-http-guard-site"));

console.log("Observation capability commit-time D1 tests passed");
