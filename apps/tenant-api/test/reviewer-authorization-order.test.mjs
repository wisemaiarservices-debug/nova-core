import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { reviewSensorCalibration } from "../src/sensor-calibration-verification.mjs";
import { reviewSensorSourceMapping } from "../src/sensor-source-identity.mjs";
import { reviewMeasurementQualityPolicy } from "../src/measurement-quality.mjs";

globalThis.crypto ??= webcrypto;

function unassignedReviewerDb() {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      return {
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          queries.push(sql);
          return { results: [] };
        },
        async run() {
          throw new Error("unexpected write");
        },
      };
    },
  };
}

test("calibration review checks reviewer assignment before reading calibration or certificate evidence", async () => {
  const db = unassignedReviewerDb();
  const result = await reviewSensorCalibration(db, "tenant-a", "site-a", "asset-a", "calibration-a",
    "reviewer-a", "request-a", { decision: "verify", evidence_ref: "certificate-a" });
  assert.equal(result.error, "calibration_reviewer_assignment_not_found");
  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0], /FROM sensor_calibration_reviewers/);
});

test("sensor mapping review checks reviewer assignment before reading mapping details", async () => {
  const db = unassignedReviewerDb();
  const result = await reviewSensorSourceMapping(db, "tenant-a", "site-a", "asset-a", "mapping-a",
    "reviewer-a", "request-a", { decision: "verify", evidence_ref: "mapping-evidence-a" });
  assert.equal(result.error, "sensor_source_mapping_reviewer_not_assigned");
  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0], /FROM sensor_source_mapping_reviewers/);
});

test("measurement quality policy review checks reviewer assignment before reading policy details", async () => {
  const db = unassignedReviewerDb();
  const result = await reviewMeasurementQualityPolicy(db, "tenant-a", "site-a", "asset-a", "policy-a",
    "reviewer-a", "request-a", { decision: "verify", evidence_ref: "policy-evidence-a" });
  assert.equal(result.error, "measurement_reviewer_assignment_not_found");
  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0], /FROM observation_reviewers/);
});
