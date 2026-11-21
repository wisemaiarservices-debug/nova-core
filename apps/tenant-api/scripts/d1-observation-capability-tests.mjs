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
    VALUES ('${id}','site-http-a','tenant-http-a',${values.asset},'${values.source || "source-http-a"}',
      'neoagro','${values.metric || "ec"}',1.5,'${values.unit || "dS/m"}',${values.observed},
      '${key}','unverified','{}',${values.flags},${capabilityValue},'${values.kind}',
      '${values.protocol}','${values.version}',${values.mode},${values.interval})`;
}

execute("approved site capability accepts an exact current observation",
  observation("obs-capability-guard-positive","ci-capability-guard-positive","capability-http-a"));
execute("approved asset capability accepts an exact current observation",
  observation("obs-capability-guard-calibrated","ci-capability-guard-calibrated","capability-http-governance",
    { asset: "'asset-http-grant" }));

expectRejected("missing capability identity",
  observation("obs-capability-guard-no-id","ci-capability-guard-no-id",null));
expectRejected("protocol mismatch",
  observation("obs-capability-guard-protocol","ci-capability-guard-protocol","capability-http-a",
    { protocol: "other-protocol" }));
expectRejected("disallowed quality flag",
  observation("obs-capability-guard-quality","ci-capability-guard-quality","capability-http-a",
    { flags: "json_array('trusted')" }));
expectRejected("site capability cannot inherit to an asset",
  observation("obs-capability-guard-asset-scope","ci-capability-guard-asset-scope","capability-http-a",
    { asset: "'asset-http-grant" }));
expectRejected("stale observation is denied",
  observation("obs-capability-guard-stale","ci-capability-guard-stale","capability-http-a",
    { observed: "strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 years')" }));
expectRejected("future observation outside approved skew is denied",
  observation("obs-capability-guard-future","ci-capability-guard-future","capability-http-a",
    { observed: "strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day')" }));

execute("calibration revocation event is appended",
  `INSERT INTO sensor_calibration_verification_events
    (id,tenant_id,site_id,asset_id,calibration_id,reviewer_subject,reviewer_role,
     event_type,evidence_ref,reason,request_id)
    VALUES ('cal-http-revoked-after-positive','tenant-http-a','site-http-a','asset-http-grant',
      'cal-http-revocation','ci-measurement-reviewer','calibration_reviewer','revoked',
      'fixture:calibration-revocation', 'CI revocation test','ci-calibration-revoke-after-positive')`);
expectRejected("revoked calibration cannot authorize a new observation",
  observation("obs-capability-guard-revoked-cal","ci-capability-guard-revoked-cal","capability-http-governance",
    { asset: "'asset-http-grant" }));

execute("capability revocation event is appended",
  `INSERT INTO source_capability_events
    (id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
    VALUES ('capability-http-a-revoked-ci','capability-http-a','tenant-http-a','site-http-a','source-http-a',
      'ci-measurement-reviewer','revoked','fixture:capability-revocation','CI revocation test',
      'ci-capability-revoke-after-positive')`);
expectRejected("revoked capability cannot authorize a new observation",
  observation("obs-capability-guard-revoked-cap","ci-capability-guard-revoked-cap","capability-http-a"));

console.log("Observation capability commit-time D1 tests passed");
