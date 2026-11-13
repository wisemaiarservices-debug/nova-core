import test from "node:test";
import assert from "node:assert/strict";
import { calculatePlantAvailableWater } from "../src/soil-water-assessment.mjs";

const volumetricProfile = () => ({ hydraulic_measurements: [
  { id: "fc", parameter: "field_capacity", value: 0.30, unit: "m3/m3", top_depth_cm: 0, bottom_depth_cm: 30, evidence_ref: "fc-report" },
  { id: "pwp", parameter: "wilting_point", value: 0.12, unit: "cm3/cm3", top_depth_cm: 0, bottom_depth_cm: 30, evidence_ref: "pwp-report" },
] });

test("calculates volumetric available water only for matching depth intervals", () => {
  const result = calculatePlantAvailableWater(volumetricProfile(), { top_depth_cm: 0, bottom_depth_cm: 30 });
  assert.equal(result.status, "calculated");
  assert.equal(result.value, 54);
  assert.equal(result.unit, "mm");
  assert.deepEqual(result.evidence_refs, ["fc-report", "pwp-report"]);
});

test("returns insufficient_inputs when hydraulic measurements or a required property is missing", () => {
  assert.equal(calculatePlantAvailableWater({}, { top_depth_cm: 0, bottom_depth_cm: 30 }).status, "insufficient_inputs");
  const profile = volumetricProfile();
  profile.hydraulic_measurements.pop();
  assert.equal(calculatePlantAvailableWater(profile, { top_depth_cm: 0, bottom_depth_cm: 30 }).reason,
    "field_capacity_or_wilting_point_missing_or_ambiguous");
});

test("does not combine mismatched depths or incompatible water-content bases", () => {
  const profile = volumetricProfile();
  profile.hydraulic_measurements[1].bottom_depth_cm = 20;
  assert.equal(calculatePlantAvailableWater(profile, { top_depth_cm: 0, bottom_depth_cm: 30 }).status, "insufficient_inputs");
  const mixed = volumetricProfile();
  mixed.hydraulic_measurements[1].unit = "kg/kg";
  assert.equal(calculatePlantAvailableWater(mixed, { top_depth_cm: 0, bottom_depth_cm: 30 }).reason,
    "water_content_units_incompatible_or_unsupported");
});

test("converts gravimetric water content using same-depth bulk density", () => {
  const profile = { hydraulic_measurements: [
    { id: "fc", parameter: "field_capacity", value: 0.25, unit: "kg/kg", top_depth_cm: 10, bottom_depth_cm: 40, evidence_ref: "fc" },
    { id: "pwp", parameter: "wilting_point", value: 0.10, unit: "g/g", top_depth_cm: 10, bottom_depth_cm: 40, evidence_ref: "pwp" },
    { id: "bd", parameter: "bulk_density", value: 1.3, unit: "g/cm3", top_depth_cm: 10, bottom_depth_cm: 40, evidence_ref: "bd" },
  ] };
  const result = calculatePlantAvailableWater(profile, { top_depth_cm: 10, bottom_depth_cm: 40 });
  assert.equal(result.status, "calculated");
  assert.equal(result.value, 58.5);
  assert.equal(result.water_content_basis, "gravimetric_converted_with_bulk_density");
});

test("rejects nonphysical ordering, ranges and invalid requested depth", () => {
  const profile = volumetricProfile();
  profile.hydraulic_measurements[0].value = 0.1;
  assert.equal(calculatePlantAvailableWater(profile, { top_depth_cm: 0, bottom_depth_cm: 30 }).reason,
    "field_capacity_below_wilting_point");
  profile.hydraulic_measurements[0].value = 1.2;
  assert.equal(calculatePlantAvailableWater(profile, { top_depth_cm: 0, bottom_depth_cm: 30 }).status, "insufficient_inputs");
  assert.equal(calculatePlantAvailableWater(profile, { top_depth_cm: 30, bottom_depth_cm: 0 }).reason,
    "requested_depth_interval_invalid");
});
