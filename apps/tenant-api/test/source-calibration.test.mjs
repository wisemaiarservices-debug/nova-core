import test from "node:test";
import assert from "node:assert/strict";
import {
  createSourceCalibration,
  reviewSourceCalibration,
  assessObservationCalibration,
} from "../src/source-calibration.mjs";

const tenant = "tenant-a", site = "site-a", source = "sensor-a";
const owner = "owner@example.test", reviewer = "reviewer@example.test";
const body = {
  instrument_serial: "SN-001", metric: "soil_moisture", unit: "%",
  calibration_method: "laboratory", calibration_standard: "ISO reference method",
  calibrated_at: "2026-10-01T10:00:00Z", valid_until: "2027-10-01T10:00:00Z",
  range_min: 0, range_max: 100, uncertainty: 0.5, evidence_ref: "lab-report:lab-001",
};

function dbFixture({ sourceExists = true, evidenceExists = true, recordStatus = "unverified",
  reviewerActive = true, calibrations = [] } = {}) {
  const state = { record: null, events: [], batches: 0, statements: [], recordStatus };
  return {
    state,
    prepare(sql) {
      return {
        sql, args: [],
        bind(...args) { this.args = args; state.statements.push({ sql, args }); return this; },
        async all() {
          if (sql.includes("FROM sources s JOIN sites")) return { results: sourceExists
            ? [{ id: source, tenant_id: tenant, site_id: site, site_status: "active" }] : [] };
          if (sql.includes("FROM laboratory_report_evidence")) return { results: evidenceExists
            ? [{ id: "lab-001" }] : [] };
          if (sql.includes("FROM observation_reviewers r JOIN tenant_memberships")) return { results: reviewerActive
            ? [{ reviewer_subject: reviewer, membership_status: "active", tenant_status: "active" }] : [] };
          if (sql.includes("FROM source_calibrations WHERE tenant_id = ? AND site_id = ? AND source_id = ? AND metric")) {
            return { results: calibrations };
          }
          if (sql.includes("FROM source_calibrations WHERE tenant_id")) return { results: state.record
            ? [{ ...state.record, status: state.recordStatus }] : [] };
          throw new Error("unexpected query: " + sql);
        },
      };
    },
    async batch(statements) {
      state.batches += 1;
      assert.equal(statements.length, 2);
      const [first, second] = statements;
      if (first.sql.includes("INSERT INTO source_calibrations")) {
        const a = first.args;
        state.record = { id: a[0], tenant_id: a[1], site_id: a[2], source_id: a[3],
          instrument_serial: a[4], metric: a[5], unit: a[6], calibration_method: a[7],
          calibration_standard: a[8], calibrated_at: a[9], valid_until: a[10],
          range_min: a[11], range_max: a[12], uncertainty: a[13], evidence_ref: a[14],
          created_by_subject: a[15], status: "unverified" };
        state.events.push({ event_type: "registered", actor_subject: owner });
      } else {
        state.events.push({ event_type: first.args[5], actor_subject: reviewer });
        state.recordStatus = first.args[5] === "verified" ? "verified" :
          first.args[5] === "rejected" ? "rejected" : "unverified";
      }
      assert.match(second.sql, /source_calibration_events/);
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    },
  };
}

test("registers a source-scoped calibration as unverified with append-only provenance", async () => {
  const db = dbFixture();
  const result = await createSourceCalibration(db, tenant, site, source, owner, "request-1", body);
  assert.equal(result.status, 201);
  assert.equal(result.data.status, "unverified");
  assert.equal(result.data.source_id, source);
  assert.equal(db.state.record.created_by_subject, owner);
  assert.equal(db.state.events.length, 1);
});

test("requires persisted same-site laboratory evidence when a lab-report reference is used", async () => {
  const db = dbFixture({ evidenceExists: false });
  const result = await createSourceCalibration(db, tenant, site, source, owner, "request-1", body);
  assert.equal(result.error, "calibration_evidence_reference_not_found");
  assert.equal(db.state.batches, 0);
});

test("rejects invalid calibration dates, range, uncertainty and unknown fields", async () => {
  const invalid = [
    { ...body, calibrated_at: "2026-02-30T10:00:00Z" },
    { ...body, valid_until: "2026-09-01T10:00:00Z" },
    { ...body, range_min: 100, range_max: 0 },
    { ...body, uncertainty: -0.1 },
    { ...body, invented: true },
  ];
  for (const item of invalid) {
    const db = dbFixture();
    const result = await createSourceCalibration(db, tenant, site, source, owner, "request-1", item);
    assert.ok([400].includes(result.status));
    assert.equal(db.state.batches, 0);
  }
});

test("requires a site-bound source and an active source site", async () => {
  const db = dbFixture({ sourceExists: false });
  const result = await createSourceCalibration(db, tenant, site, source, owner, "request-1", body);
  assert.equal(result.error, "source_not_found_in_site_scope");
});

test("independent assigned reviewer verifies a calibration; uploader cannot self-review", async () => {
  const db = dbFixture();
  const created = await createSourceCalibration(db, tenant, site, source, owner, "request-1", body);
  const self = await reviewSourceCalibration(db, tenant, site, source, created.data.id, owner, "request-2",
    { decision: "verify", evidence_ref: "inspection:self" });
  assert.equal(self.error, "source_calibration_self_review_denied");
  const verified = await reviewSourceCalibration(db, tenant, site, source, created.data.id, reviewer, "request-3",
    { decision: "verify", evidence_ref: "inspection:independent" });
  assert.equal(verified.status, 201);
  assert.equal(verified.data.status, "verified");
  assert.equal(db.state.recordStatus, "verified");
});

test("does not accept a reviewer with inactive tenant membership", async () => {
  const db = dbFixture({ reviewerActive: false });
  const created = await createSourceCalibration(db, tenant, site, source, owner, "request-1", body);
  const result = await reviewSourceCalibration(db, tenant, site, source, created.data.id, reviewer, "request-2",
    { decision: "verify", evidence_ref: "inspection:independent" });
  assert.equal(result.error, "source_calibration_reviewer_not_assigned");
});

test("assessment reports calibration coverage only for one verified, current, in-range record", async () => {
  const calibration = { id: "cal-1", instrument_serial: "SN-001",
    calibration_method: "laboratory", calibration_standard: "ISO reference method",
    calibrated_at: "2026-10-01T10:00:00.000Z", valid_until: "2027-10-01T10:00:00.000Z",
    range_min: 0, range_max: 100, uncertainty: 0.5, status: "verified",
    evidence_ref: "lab-report:lab-001" };
  const observation = { id: "obs-1", source_id: source, site_id: site,
    metric: "soil_moisture", unit: "%", value: 45, observed_at: "2026-11-01T10:00:00.000Z",
    verification_status: "unverified", quality_flags_json: '["sensor_calibration_due"]' };
  const db = dbFixture({ calibrations: [calibration] });
  const result = await assessObservationCalibration(db, tenant, observation);
  assert.equal(result.status, "covered_by_verified_calibration");
  assert.equal(result.observation_verification_status, "unverified");
  assert.deepEqual(result.ingestion_quality_flags, ["sensor_calibration_due"]);
});

test("assessment fails closed for missing, pending, ambiguous and out-of-range calibrations", async () => {
  const observation = { id: "obs-1", source_id: source, site_id: site,
    metric: "soil_moisture", unit: "%", value: 105, observed_at: "2026-11-01T10:00:00.000Z",
    verification_status: "verified", quality_flags_json: "[]" };
  const pending = await assessObservationCalibration(dbFixture({ calibrations: [
    { id: "cal-pending", status: "unverified" },
  ] }), tenant, observation);
  assert.equal(pending.reason, "calibration_pending_human_review");
  const missing = await assessObservationCalibration(dbFixture(), tenant, observation);
  assert.equal(missing.reason, "no_verified_calibration_covers_observation_time");
  const base = { id: "cal-1", range_min: 0, range_max: 100, status: "verified" };
  const ambiguous = await assessObservationCalibration(dbFixture({ calibrations: [
    base, { ...base, id: "cal-2" },
  ] }), tenant, observation);
  assert.equal(ambiguous.reason, "multiple_verified_calibrations_cover_observation_time");
  const outOfRange = await assessObservationCalibration(dbFixture({ calibrations: [base] }), tenant, observation);
  assert.equal(outOfRange.reason, "observation_outside_verified_calibration_range");
});
