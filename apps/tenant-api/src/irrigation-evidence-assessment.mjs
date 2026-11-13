import { assessIrrigationSpatialCoverage } from "./irrigation-spatial-assessment.mjs";
import { calculateRootZoneAvailableWater } from "./soil-water-assessment.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Consolidates declared, measured and calculated irrigation evidence for one
 * explicitly selected zone. It does not make an operational decision.
 */
export function buildIrrigationEvidenceAssessment(payload, {
  irrigation_system_id,
  zone_id,
  root_depth_observation_ids = {},
} = {}) {
  const insufficient = (reason, details = {}) => ({
    status: "insufficient_inputs", reason, ...details,
  });
  const site = payload?.site;
  if (!isObject(site) || !Array.isArray(site.irrigation_systems)) {
    return insufficient("irrigation_systems_missing");
  }
  if (typeof irrigation_system_id !== "string" || !irrigation_system_id ||
      typeof zone_id !== "string" || !zone_id) {
    return insufficient("irrigation_system_and_zone_selection_required");
  }
  const systems = site.irrigation_systems.filter(item =>
    isObject(item) && item.id === irrigation_system_id);
  if (systems.length !== 1) return insufficient("irrigation_system_not_found_or_ambiguous");
  const system = systems[0];
  if (!Array.isArray(system.zones)) return insufficient("irrigation_zones_missing");
  const zones = system.zones.filter(item => isObject(item) && item.id === zone_id);
  if (zones.length !== 1) return insufficient("irrigation_zone_not_found_or_ambiguous");
  const zone = zones[0];

  const sources = Array.isArray(site.water_sources) ? site.water_sources : [];
  const sourceMatches = sources.filter(item => isObject(item) &&
    item.id === system.water_source_id);
  const waterSource = sourceMatches.length === 1 ? sourceMatches[0] : null;
  const profileMatches = Array.isArray(site.soil_profiles)
    ? site.soil_profiles.filter(item => isObject(item) && item.id === zone.soil_profile_id)
    : [];
  const profile = profileMatches.length === 1 ? profileMatches[0] : null;

  const qualitySamples = Array.isArray(waterSource?.quality_samples)
    ? waterSource.quality_samples : [];
  const qualityEvidence = {
    status: !waterSource ? "unassessed" :
      qualitySamples.length ? "samples_recorded_not_interpreted" : "samples_missing",
    sample_count: qualitySamples.length,
    provenance_incomplete_count: qualitySamples.filter(sample =>
      !isObject(sample) || !sample.method || !sample.laboratory || !sample.evidence_ref).length,
    sample_ids: qualitySamples.filter(isObject).map(sample => sample.id).filter(Boolean),
    interpretation: "not_assessed",
  };

  const spatial = assessIrrigationSpatialCoverage(payload);
  const spatialZone = spatial.zones.find(item =>
    item.irrigation_system_id === irrigation_system_id && item.zone_id === zone_id) ?? {
      status: "spatial_coverage_unassessed",
      reason: "zone_spatial_assessment_not_available",
      counts: { inside_zone: 0, outside_zone: 0, boundary_ambiguous: 0, unlocated: 0, unique_locations: 0 },
      samples: [],
    };

  const cropIds = Array.isArray(zone.crop_ids) ? zone.crop_ids : [];
  const crops = Array.isArray(site.crops) ? site.crops : [];
  const rootZoneAssessments = cropIds.map(cropId => {
    const matches = crops.filter(crop => isObject(crop) && crop.id === cropId);
    if (matches.length !== 1 || !profile) {
      return { crop_id: cropId, status: "insufficient_inputs",
        reason: matches.length !== 1 ? "linked_crop_missing_or_ambiguous" : "linked_soil_profile_missing" };
    }
    const crop = matches[0];
    const observationId = root_depth_observation_ids[cropId];
    if (!observationId) {
      return { crop_id: cropId, status: "insufficient_inputs",
        reason: "explicit_root_depth_observation_selection_required" };
    }
    return { crop_id: cropId,
      ...calculateRootZoneAvailableWater(profile, crop, { observation_id: observationId }) };
  });

  const sourceFlow = waterSource?.available_flow_m3_per_hour;
  const designFlow = system.design_flow_m3_per_hour;
  const flowComparison = Number.isFinite(sourceFlow) && Number.isFinite(designFlow)
    ? {
        status: sourceFlow < designFlow ? "declared_source_flow_below_declared_design_flow" : "declared_values_not_in_conflict",
        source_available_flow_m3_per_hour: sourceFlow,
        system_design_flow_m3_per_hour: designFlow,
      }
    : { status: "not_assessed", reason: "both_declared_flow_values_required" };

  const evidenceRefs = [...new Set([
    waterSource?.evidence_ref,
    ...qualitySamples.map(sample => sample?.evidence_ref),
    profile?.evidence_ref,
    ...rootZoneAssessments.flatMap(item => item.evidence_refs ?? []),
  ].filter(value => typeof value === "string" && value.length > 0))];

  return Object.freeze({
    status: "evidence_consolidated_with_limits",
    selection: Object.freeze({ irrigation_system_id, zone_id }),
    water_source: waterSource ? Object.freeze({
      id: waterSource.id,
      source_type: waterSource.source_type ?? "unknown",
      available_flow_m3_per_hour: sourceFlow ?? null,
      permitted_abstraction_m3_per_day: waterSource.permitted_abstraction_m3_per_day ?? null,
      quality: Object.freeze(qualityEvidence),
      flow_comparison: Object.freeze(flowComparison),
    }) : Object.freeze({ status: "unresolved", reason: "linked_water_source_not_found_or_ambiguous" }),
    soil: Object.freeze({
      profile_id: profile?.id ?? null,
      status: profile ? "linked_profile_found" : "unresolved",
      sample_count: Array.isArray(profile?.samples) ? profile.samples.length : 0,
      spatial_coverage: spatialZone,
      root_zone_calculations: Object.freeze(rootZoneAssessments),
    }),
    evidence_refs: Object.freeze(evidenceRefs),
    limitations: Object.freeze([
      "declared_source_flow_is_not_verified_supply_or_sustainable_yield",
      "daily_abstraction_limit_is_not_compared_without_a_validated_operating_period",
      "water_quality_samples_are_not_interpreted_for_crop_or_irrigation_suitability",
      "soil_sample_point_inclusion_does_not_establish_representativeness",
      "root_zone_water_is_a_deterministic_calculation_not_crop_demand",
      "no_hydraulic_network_or_pump_performance_model_is_applied",
      "no_irrigation_schedule_or_operational_recommendation_is_made",
      "human_engineering_and_regulatory_review_remain_required",
    ]),
    operational_decision: "not_authorized",
    model_applicability: "not_assessed",
  });
}
