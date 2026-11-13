import test from "node:test";
import assert from "node:assert/strict";
import { calculateRootZoneAvailableWater } from "../src/soil-water-assessment.mjs";

const profile = () => ({ hydraulic_measurements: [
  { id: "fc-0-20", parameter: "field_capacity", value: 0.30, unit: "m3/m3", top_depth_cm: 0, bottom_depth_cm: 20, evidence_ref: "fc-a" },
  { id: "pwp-0-20", parameter: "wilting_point", value: 0.10, unit: "m3/m3", top_depth_cm: 0, bottom_depth_cm: 20, evidence_ref: "pwp-a" },
  { id: "fc-20-40", parameter: "field_capacity", value: 0.28, unit: "m3/m3", top_depth_cm: 20, bottom_depth_cm: 40, evidence_ref: "fc-b" },
  { id: "pwp-20-40", parameter: "wilting_point", value: 0.13, unit: "m3/m3", top_depth_cm: 20, bottom_depth_cm: 40, evidence_ref: "pwp-b" },
] });
const crop = () => ({ id: "crop-1", root_depth_observations: [
  { id: "root-observation-1", root_depth_cm: 40, growth_stage: "vegetative", source_type: "measured", evidence_ref: "root-report" },
] });

test("aggregates contiguous evidence-backed layers to the selected root depth", () => {
  const result = calculateRootZoneAvailableWater(profile(), crop(), { observation_id: "root-observation-1" });
  assert.equal(result.status, "calculated");
  assert.equal(result.value, 70);
  assert.equal(result.unit, "mm");
  assert.deepEqual(result.evidence_refs, ["root-report", "fc-a", "pwp-a", "fc-b", "pwp-b"]);
});

test("requires explicit root-depth observation selection and complete contiguous coverage", () => {
  assert.equal(calculateRootZoneAvailableWater(profile(), crop()).reason, "root_depth_observation_selection_required");
  const gap = profile();
  gap.hydraulic_measurements = gap.hydraulic_measurements.filter(item => item.top_depth_cm !== 20);
  assert.equal(calculateRootZoneAvailableWater(gap, crop(), { observation_id: "root-observation-1" }).reason,
    "soil_profile_does_not_cover_root_depth");
});

test("does not extrapolate a layer beyond the observed root depth", () => {
  const data = profile();
  data.hydraulic_measurements = data.hydraulic_measurements.slice(0, 2);
  const selectedCrop = crop();
  selectedCrop.root_depth_observations[0].root_depth_cm = 30;
  assert.equal(calculateRootZoneAvailableWater(data, selectedCrop, { observation_id: "root-observation-1" }).reason,
    "soil_profile_does_not_cover_root_depth");
});

test("returns insufficient inputs for incomplete hydraulic evidence", () => {
  const data = profile();
  data.hydraulic_measurements = data.hydraulic_measurements.filter(item => item.id !== "pwp-20-40");
  assert.equal(calculateRootZoneAvailableWater(data, crop(), { observation_id: "root-observation-1" }).reason,
    "soil_layer_calculation_incomplete");
});
