import test from "node:test";
import assert from "node:assert/strict";
import { buildIrrigationEvidenceAssessment } from "../src/irrigation-evidence-assessment.mjs";

function payload() {
  return {
    site: {
      water_sources: [{
        id: "well-1", source_type: "groundwater",
        available_flow_m3_per_hour: 4,
        permitted_abstraction_m3_per_day: 30,
        quality_samples: [{ id: "water-sample-1", method: "lab method", laboratory: "Lab A", evidence_ref: "water-report" }],
        evidence_ref: "well-register",
      }],
      soil_profiles: [{
        id: "soil-1", evidence_ref: "soil-register",
        samples: [{ id: "soil-sample-1", sampling_point: { crs: "EPSG:4326", coordinates: [1,1] } }],
        hydraulic_measurements: [
          { parameter: "field_capacity", value: 0.3, unit: "m3/m3", top_depth_cm: 0, bottom_depth_cm: 20, evidence_ref: "fc" },
          { parameter: "wilting_point", value: 0.1, unit: "m3/m3", top_depth_cm: 0, bottom_depth_cm: 20, evidence_ref: "pwp" },
        ],
      }],
      crops: [{
        id: "crop-1",
        root_depth_observations: [{
          id: "root-1", root_depth_cm: 20, growth_stage: "vegetative",
          source_type: "measured", evidence_ref: "root-report",
        }],
      }],
      irrigation_systems: [{
        id: "system-1", water_source_id: "well-1", design_flow_m3_per_hour: 5,
        zones: [{
          id: "zone-1", soil_profile_id: "soil-1", crop_ids: ["crop-1"],
          boundary: { type: "Polygon", crs: "EPSG:4326",
            coordinates: [[[0,0],[2,0],[2,2],[0,2],[0,0]]] },
        }],
      }],
    },
  };
}

test("consolidates declared source, sample provenance, spatial and root-zone evidence", () => {
  const result = buildIrrigationEvidenceAssessment(payload(), {
    irrigation_system_id: "system-1", zone_id: "zone-1",
    root_depth_observation_ids: { "crop-1": "root-1" },
  });
  assert.equal(result.status, "evidence_consolidated_with_limits");
  assert.equal(result.water_source.flow_comparison.status,
    "declared_source_flow_below_declared_design_flow");
  assert.equal(result.water_source.quality.status, "samples_recorded_not_interpreted");
  assert.equal(result.soil.spatial_coverage.counts.inside_zone, 1);
  assert.equal(result.soil.root_zone_calculations[0].status, "calculated");
  assert.equal(result.operational_decision, "not_authorized");
  assert.ok(result.evidence_refs.includes("water-report"));
  assert.ok(result.evidence_refs.includes("root-report"));
});

test("keeps absent water source, quality and root-depth selection explicitly unresolved", () => {
  const data = payload();
  data.site.irrigation_systems[0].water_source_id = "unknown-source";
  const result = buildIrrigationEvidenceAssessment(data, {
    irrigation_system_id: "system-1", zone_id: "zone-1",
  });
  assert.equal(result.water_source.status, "unresolved");
  assert.equal(result.soil.root_zone_calculations[0].reason,
    "explicit_root_depth_observation_selection_required");
});

test("requires explicit system and zone selection and rejects ambiguous identifiers", () => {
  assert.equal(buildIrrigationEvidenceAssessment(payload()).reason,
    "irrigation_system_and_zone_selection_required");
  const data = payload();
  data.site.irrigation_systems.push(data.site.irrigation_systems[0]);
  assert.equal(buildIrrigationEvidenceAssessment(data, {
    irrigation_system_id: "system-1", zone_id: "zone-1",
  }).reason, "irrigation_system_not_found_or_ambiguous");
});

test("does not turn water-quality provenance into suitability conclusions", () => {
  const data = payload();
  data.site.water_sources[0].quality_samples[0].method = null;
  const result = buildIrrigationEvidenceAssessment(data, {
    irrigation_system_id: "system-1", zone_id: "zone-1",
  });
  assert.equal(result.water_source.quality.provenance_incomplete_count, 1);
  assert.equal(result.water_source.quality.interpretation, "not_assessed");
});
