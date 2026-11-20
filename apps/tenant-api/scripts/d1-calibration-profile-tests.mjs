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

console.log("Source calibration profile registry D1 tests passed");
