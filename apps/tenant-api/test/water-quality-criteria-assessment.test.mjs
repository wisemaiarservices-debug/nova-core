import test from "node:test";
import assert from "node:assert/strict";
import { assessWaterQualityAgainstDeclaredCriteria } from "../src/water-quality-criteria-assessment.mjs";

const context = {
  jurisdiction: "TN",
  crop_id: "crop-olive",
  irrigation_method: "drip",
  intended_use: "agricultural_irrigation",
};
const criteriaSet = {
  id: "criteria-2026-01",
  authority: "Example authority (test fixture only)",
  title: "Example referenced criteria",
  version: "2026.1",
  effective_from: "2026-01-01",
  evidence_ref: "criteria-document",
  criteria: [{
    parameter: "electrical_conductivity",
    unit: "dS/m",
    jurisdiction: "TN",
    crop_id: "crop-olive",
    irrigation_method: "drip",
    intended_use: "agricultural_irrigation",
    operator: "max",
    value: 2,
    reference_clause: "fixture clause 4",
    evidence_ref: "criteria-clause",
  }],
};
const samples = [{
  id: "sample-1", parameter: "electrical_conductivity",
  value: 1.5, unit: "dS/m", sampled_at: "2026-05-10T10:00:00Z",\n  provenance: { source_type: "measured", method: "field_meter", evidence_ref: "evidence:sample-1" },
}];

test("compares only an exact jurisdiction, crop, method, use, parameter and unit match", () => {
  const result = assessWaterQualityAgainstDeclaredCriteria(samples, context, criteriaSet);
  assert.equal(result.status, "declared_criteria_comparison_complete");
  assert.equal(result.results[0].status, "within_declared_criterion");
  assert.equal(result.legal_status, "not_verified");
  assert.equal(result.scientific_suitability, "not_assessed");
  assert.equal(result.operational_decision, "not_authorized");
});

test("does not apply a criterion across crop, jurisdiction, irrigation method or unit", () => {
  for (const change of [
    { jurisdiction: "XX" }, { crop_id: "crop-other" },
    { irrigation_method: "sprinkler" }, { intended_use: "other" },
  ]) {
    const result = assessWaterQualityAgainstDeclaredCriteria(samples, { ...context, ...change }, criteriaSet);
    assert.equal(result.results[0].reason, "no_exactly_scoped_criterion");
  }
  const otherUnit = [{ ...samples[0], unit: "mg/L" }];
  assert.equal(assessWaterQualityAgainstDeclaredCriteria(otherUnit, context, criteriaSet)
    .results[0].reason, "no_exactly_scoped_criterion");
});

test("does not compare samples outside the criterion effective period", () => {
  const old = [{ ...samples[0], sampled_at: "2025-12-31T23:59:59Z" }];
  assert.equal(assessWaterQualityAgainstDeclaredCriteria(old, context, criteriaSet)
    .results[0].reason, "criterion_not_effective_on_sample_date");
});

test("preserves missing, ambiguous and unsupported criteria as not assessed", () => {
  assert.equal(assessWaterQualityAgainstDeclaredCriteria(samples, {}, criteriaSet).reason,
    "explicit_jurisdiction_crop_method_and_use_required");
  const ambiguous = { ...criteriaSet, criteria: [...criteriaSet.criteria, ...criteriaSet.criteria] };
  assert.equal(assessWaterQualityAgainstDeclaredCriteria(samples, context, ambiguous)
    .results[0].reason, "criterion_ambiguous");
  const missingEvidence = { ...criteriaSet, evidence_ref: "" };
  assert.equal(assessWaterQualityAgainstDeclaredCriteria(samples, context, missingEvidence).reason,
    "criteria_set_provenance_or_effective_dates_incomplete");
});

test("reports values outside a declared criterion without declaring them unsafe", () => {
  const high = [{ ...samples[0], value: 3 }];
  const result = assessWaterQualityAgainstDeclaredCriteria(high, context, criteriaSet);
  assert.equal(result.results[0].status, "outside_declared_criterion");
  assert.equal(result.scientific_suitability, "not_assessed");
  assert.equal(result.operational_decision, "not_authorized");
});

test("requires a valid timezone-qualified sample timestamp", () => {
  for (const sampled_at of ["2026-05-10", "2026-02-30T10:00:00Z", "2026-05-10T10:00:00"]) {
    const result = assessWaterQualityAgainstDeclaredCriteria(
      [{ ...samples[0], sampled_at }], context, criteriaSet);
    assert.equal(result.results[0].reason, "sample_value_unit_or_date_invalid");
  }
});


test("requires explicit sample provenance and never assesses synthetic fixtures", () => {
  const missing = assessWaterQualityAgainstDeclaredCriteria(
    [{ ...samples[0], provenance: undefined }], context, criteriaSet);
  assert.equal(missing.results[0].reason, "sample_provenance_incomplete_or_invalid");
  const synthetic = assessWaterQualityAgainstDeclaredCriteria(
    [{ ...samples[0], provenance: { source_type: "synthetic", method: "test_fixture", evidence_ref: "fixture:sample" } }],
    context, criteriaSet);
  assert.equal(synthetic.results[0].status, "not_assessed");
  assert.equal(synthetic.results[0].reason, "synthetic_sample_not_eligible_for_field_assessment");
});

test("requires laboratory and model identities for those provenance classes", () => {
  const laboratory = assessWaterQualityAgainstDeclaredCriteria(
    [{ ...samples[0], provenance: { source_type: "laboratory", method: "ion_chromatography", evidence_ref: "report:1" } }],
    context, criteriaSet);
  assert.equal(laboratory.results[0].reason, "laboratory_identity_missing");
  const modelled = assessWaterQualityAgainstDeclaredCriteria(
    [{ ...samples[0], provenance: { source_type: "modelled", method: "downscaling", evidence_ref: "model:1" } }],
    context, criteriaSet);
  assert.equal(modelled.results[0].reason, "model_identity_missing");
  const complete = assessWaterQualityAgainstDeclaredCriteria(
    [{ ...samples[0], provenance: { source_type: "laboratory", method: "ion_chromatography",
      laboratory: "Declared lab", evidence_ref: "report:1" } }], context, criteriaSet);
  assert.equal(complete.results[0].sample_provenance.verification_status, "not_independently_verified");
});
