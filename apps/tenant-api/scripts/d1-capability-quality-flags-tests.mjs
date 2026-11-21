import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const wrangler = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];

function run(label, sql) {
  const result = spawnSync("npx", [...wrangler, sql], { encoding: "utf8" });
  const output = (result.stdout || "") + "\n" + (result.stderr || "");
  assert.equal(result.status, 0, label + " failed\n" + output);
  console.log("Passed: " + label);
}

function reject(label, sql) {
  const result = spawnSync("npx", [...wrangler, sql], { encoding: "utf8" });
  const output = (result.stdout || "") + "\n" + (result.stderr || "");
  assert.notEqual(result.status, 0, label + " unexpectedly succeeded\n" + output);
  assert.match(
    output,
    /source capability quality flags must be unique valid identifiers/,
    label + " failed for an unexpected reason\n" + output,
  );
  console.log("Rejected as expected: " + label);
}

function insertCapability(id, version, flagsJson) {
  return `INSERT INTO source_capabilities
    (id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,
     quantity_semantics,acquisition_protocol,protocol_version,sampling_mode,interval_seconds,
     max_age_seconds,max_future_skew_seconds,timezone,allowed_quality_flags_json,
     calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,version,status,created_by_subject)
    VALUES ('${id}','tenant-http-a','site-http-a','source-http-grant',NULL,
      'neoagro','ec','dS/m','measured','CI quality flags guard','manual-lab','1.0','interval',3600,
      31536000,300,'Africa/Tunis',${flagsJson},
      0,NULL,'fixture:rights','fixture:quality-flags',${version},'pending','ci-human-subject')`;
}

run("empty quality-flag allow-list is valid",
  insertCapability("quality-flags-ci-empty", 100, "'[]'"));

const max32 = Array.from({ length: 32 }, (_, i) => "'flag" + String(i + 1).padStart(2, "0") + "'");
run("32 unique valid quality flags are accepted",
  insertCapability("quality-flags-ci-max32", 101, "json_array(" + max32.join(",") + ")"));

run("valid identifier punctuation is accepted",
  insertCapability("quality-flags-ci-identifiers", 102,
    "json_array('A-1','sensor:verified','flag.v2','quality_flag')"));

reject("non-string quality flag is rejected",
  insertCapability("quality-flags-ci-non-string", 103, "json_array('trusted',7)"));
reject("duplicate quality flag is rejected",
  insertCapability("quality-flags-ci-duplicate", 104, "json_array('trusted','trusted')"));
reject("more than 32 quality flags are rejected",
  insertCapability("quality-flags-ci-over-limit", 105,
    "json_array(" + [...max32, "'flag33'"].join(",") + ")"));
reject("leading or trailing whitespace is rejected",
  insertCapability("quality-flags-ci-whitespace", 106, "json_array(' trusted')"));
reject("invalid punctuation is rejected",
  insertCapability("quality-flags-ci-invalid-char", 107, "json_array('sensor/verified')"));
reject("identifier longer than 64 characters is rejected",
  insertCapability("quality-flags-ci-too-long", 108, "json_array('" + "a".repeat(65) + "')"));
reject("identifier must start with an ASCII letter or digit",
  insertCapability("quality-flags-ci-invalid-first", 109, "json_array('_trusted')"));
reject("non-array JSON is rejected by the insert guard",
  insertCapability("quality-flags-ci-not-array", 110, "'{}'"));


function rejectContract(label, sql) {
  const result = spawnSync("npx", [...wrangler, sql], { encoding: "utf8" });
  const output = (result.stdout || "") + "\\n" + (result.stderr || "");
  assert.notEqual(result.status, 0, label + " unexpectedly succeeded\\n" + output);
  assert.match(
    output,
    /source capability fields violate the canonical draft contract/,
    label + " failed for an unexpected reason\\n" + output,
  );
  console.log("Rejected as expected: " + label);
}

rejectContract("metric separators must be canonical",
  insertCapability("quality-flags-ci-bad-metric", 111, "'[]'")
    .replace("'ec'", "'soil..moisture'"));
rejectContract("acquisition protocol must be an identifier",
  insertCapability("quality-flags-ci-bad-protocol", 112, "'[]'")
    .replace("'manual-lab'", "'manual lab'"));
rejectContract("timezone must have canonical IANA-style structure",
  insertCapability("quality-flags-ci-bad-timezone", 113, "'[]'")
    .replace("'Africa/Tunis'", "'/Africa/Tunis'"));
rejectContract("data-rights reference cannot traverse path segments",
  insertCapability("quality-flags-ci-bad-rights-ref", 114, "'[]'")
    .replace("'fixture:rights'", "'../private'"));
rejectContract("evidence reference cannot traverse path segments",
  insertCapability("quality-flags-ci-bad-evidence-ref", 115, "'[]'")
    .replace("'fixture:quality-flags'", "'evidence/../private'"));
rejectContract("quantity semantics cannot contain control characters",
  insertCapability("quality-flags-ci-control-semantics", 116, "'[]'")
    .replace("'CI quality flags guard'", "CAST('invalid' || char(1) AS TEXT)"));
rejectContract("unit cannot contain Unicode whitespace",
  insertCapability("quality-flags-ci-unicode-space-unit", 117, "'[]'")
    .replace("'dS/m'", "'dS/ｍ　m'"));

console.log("Source capability quality-flag and capability contract D1 tests passed");
