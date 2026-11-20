import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const args = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];

function expectRejected(label, sql, expectedReason) {
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
  const output = (result.stdout || "") + "\n" + (result.stderr || "");
  assert.notEqual(result.status, 0, label + " unexpectedly succeeded\n" + output);
  assert.match(output, new RegExp(expectedReason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    label + " failed for an unexpected reason\n" + output);
  console.log("Rejected for expected reason: " + label);
}

const insert = (id, mapping, parameter, creator) =>
  "INSERT INTO source_calibration_profiles " +
  "(profile_ref,tenant_id,site_id,asset_id,source_id,mapping_id,parameter,unit,evidence_ref,created_by_subject) VALUES (" +
  "'" + id + "','tenant-http-a','site-http-a','asset-http-grant','source-http-a','" +
  mapping + "','" + parameter + "','dS/m','fixture:negative-profile-test','" + creator + "')";

expectRejected(
  "pending source mapping cannot create a calibration profile",
  insert("profile-http-pending-denied", "mapping-http-pending", "ec", "ci-human-subject"),
  "calibration profile requires active scope, member and currently verified exact source mapping",
);

expectRejected(
  "profile parameter cannot diverge from the reviewed mapping",
  insert("profile-http-parameter-denied", "mapping-http-revocation", "temperature", "ci-human-subject"),
  "calibration profile requires active scope, member and currently verified exact source mapping",
);

expectRejected(
  "inactive or unknown creator cannot register a profile",
  insert("profile-http-creator-denied", "mapping-http-revocation", "ec", "ci-not-a-member"),
  "calibration profile requires active scope, member and currently verified exact source mapping",
);

expectRejected(
  "profile identity cannot be modified",
  "UPDATE source_calibration_profiles SET evidence_ref='tampered' WHERE profile_ref='profile-http-calibration'",
  "source calibration profiles are immutable",
);

expectRejected(
  "profile identity cannot be deleted",
  "DELETE FROM source_calibration_profiles WHERE profile_ref='profile-http-calibration'",
  "source calibration profiles cannot be deleted",
);


function execute(label, sql) {
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
  const output = (result.stdout || "") + "\\n" + (result.stderr || "");
  assert.equal(result.status, 0, label + " failed\\n" + output);
  console.log("Passed: " + label);
}

const capabilityInsert = (id, metric, unit, profileRef, version) =>
  "INSERT INTO source_capabilities " +
  "(id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind," +
  "quantity_semantics,acquisition_protocol,protocol_version,sampling_mode,interval_seconds," +
  "max_age_seconds,max_future_skew_seconds,timezone,allowed_quality_flags_json," +
  "calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,version,status,created_by_subject) VALUES (" +
  "'" + id + "','tenant-http-a','site-http-a','source-http-a','asset-http-grant','neoagro','" +
  metric + "','" + unit + "','measured','CI calibration capability','manual-lab','1.0'," +
  "'interval',3600,7200,300,'Africa/Tunis','[]',1,'" + profileRef +
  "','fixture:rights','fixture:evidence'," + version + ",'pending','ci-human-subject')";

execute(
  "calibration-required capability accepts exact registered profile",
  capabilityInsert("capability-http-calibrated", "ec", "dS/m", "profile-http-calibration", 2),
);

expectRejected(
  "calibration-required capability without a profile is denied",
  capabilityInsert("capability-http-no-profile", "ec", "dS/m", "missing-profile", 3),
  "calibration-required capability must reference an exact tenant/site/asset/source/metric/unit profile",
);

expectRejected(
  "calibration-required capability with metric mismatch is denied",
  capabilityInsert("capability-http-metric-mismatch", "temperature", "dS/m", "profile-http-calibration", 4),
  "calibration-required capability must reference an exact tenant/site/asset/source/metric/unit profile",
);

console.log("Source calibration profile registry D1 tests passed");
