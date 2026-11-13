import test from "node:test";
import assert from "node:assert/strict";
import { assessConsolidatedIrrigationEvidence } from "../src/consolidated-irrigation-assessment.mjs";

const base = () => ({
  site: {
    site_id: "site-1",
    crops: [{ id: "crop-1", root_depth_observations: [{
      id: "root-1", root_depth_cm: 20, growth_stage: "vegetative",
      source_type: "measured", evidence_ref: "root-evidence",
    }] }],
    soil_profiles: [{
      id: "soil-1",
      samples: [{ id: "sample-1", sampling_point: { crs: "EPSG:4326", coordinates: [1,1] }, evidence_ref: "soil-sample" }],
      hydraulic_measurements: [
        { parameter: "field_capacity", value: 0.3, unit: "m3/m3", top_depth_cm: 0, bottom_depth_cm: 20, evidence_ref: "fc" },
        { parameter: "wilting_point", value: 0.1, unit: "m3/m3", top_depth_cm: 0, bottom_depth_cm: 20, evidence_ref: "pwp" },
      ],
    }],
    water_sources: [{
      id: "source-1", source_type: "groundwater",
      available_flow_m3_per_hour: 4, permitted_abstraction_m3_per_day: 30,
      quality_samples: [{
        id: "water-sample-1", parameter: "electrical_conductivity",
        value: 1.2, unit: "dS/m", sampled_at: "2026-10-01T10:00:00Z",
        method: "lab method", laboratory: "Lab A", evidence_ref: "water-report",
      }],
    }],
    irrigation_systems: [{
      id: "system-1", water_source_id: "source-1",
      zones: [{
        id: "zone-1", soil_profile_id: "soil-1", crop_ids: ["crop-1"],
        design_flow_m3_per_hour: 3,
        boundary: { type: "Polygon", crs: "EPSG:4326",
          coordinates: [[[0,0],[2,0],[2,2],[0,2],[0,0]]] },
      }],
    }],
  },
});

test("consolidates spatial, root-zone, source-flow and quality provenance evidence", () => {
  const result = assessConsolidatedIrrigationEvidence(base(), {
    rootDepthObservationIds: { "crop-1": "root-1" },
  });
  assert.equal(result.status, "evidence_consolidated_with_limits");
  assert.equal(result.summary.root_zone_calculations_completed, 1);
  assert.equal(result.zones[0].crop_root_zone_assessments[0].root_zone_available_water.value, 40);
  assert.equal(result.zones[0].declared_capacity_comparison.status, "declared_ratings_within_source_flow");
  assert.equal(result.zones[0].water_source.quality_interpretation, "not_assessed");
  assert.ok(result.zones[0].evidence_refs.includes("water-report"));
  assert.equal(result.decision_status.operational_approval, "not_granted");
});

test("does not choose root-depth observations implicitly", () => {
  const result = assessConsolidatedIrrigationEvidence(base());
  assert.equal(result.summary.root_zone_calculations_insufficient, 1);
  assert.equal(result.zones[0].crop_root_zone_assessments[0].root_zone_available_water.reason,
    "root_depth_observation_selection_required");
});

test("keeps missing source flow and missing spatial evidence unassessed", () => {
  const data = base();
  delete data.site.water_sources[0].available_flow_m3_per_hour;
  delete data.site.irrigation_systems[0].zones[0].boundary;
  const result = assessConsolidatedIrrigationEvidence(data);
  assert.equal(result.zones[0].declared_capacity_comparison.status, "not_assessed");
  assert.equal(result.zones[0].spatial_assessment.status, "spatial_coverage_unassessed");
});

test("flags a declared zone flow exceeding declared source flow without claiming hydraulic failure", () => {
  const data = base();
  data.site.irrigation_systems[0].zones[0].design_flow_m3_per_hour = 5;
  const result = assessConsolidatedIrrigationEvidence(data, {
    rootDepthObservationIds: { "crop-1": "root-1" },
  });
  assert.equal(result.summary.declared_flow_comparisons_flagged, 1);
  assert.equal(result.zones[0].declared_capacity_comparison.status,
    "declared_zone_flow_exceeds_source_flow");
  assert.equal(result.decision_status.engineering_review, "not_started");
});

test("does not treat daily abstraction allowance as an hourly flow rating", () => {
  const data = base();
  delete data.site.water_sources[0].available_flow_m3_per_hour;
  const result = assessConsolidatedIrrigationEvidence(data);
  assert.equal(result.zones[0].declared_capacity_comparison.reason,
    "declared_source_flow_missing");
  assert.equal(result.zones[0].water_source.permitted_abstraction_m3_per_day, 30);
});
