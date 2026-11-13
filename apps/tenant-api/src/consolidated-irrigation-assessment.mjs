import { assessIrrigationSpatialCoverage } from "./irrigation-spatial-assessment.mjs";
import { calculateRootZoneAvailableWater } from "./soil-water-assessment.mjs";

/**
 * Consolidates existing tenant/site evidence into a review-oriented report.
 * No missing values are inferred and no agronomic or operational decisions are made.
 */
export function assessConsolidatedIrrigationEvidence(payload, {
  rootDepthObservationIds = {},
} = {}) {
  const site = payload?.site;
  const systems = Array.isArray(site?.irrigation_systems) ? site.irrigation_systems : [];
  const profiles = Array.isArray(site?.soil_profiles) ? site.soil_profiles : [];
  const crops = Array.isArray(site?.crops) ? site.crops : [];
  const waterSources = Array.isArray(site?.water_sources) ? site.water_sources : [];
  const spatial = assessIrrigationSpatialCoverage(payload);
  const spatialByZone = new Map(spatial.zones.map(zone => [
    zone.irrigation_system_id + ":" + zone.zone_id, zone,
  ]));
  const zones = [];

  for (const system of systems) {
    if (!system || typeof system !== "object" || !Array.isArray(system.zones)) continue;
    const source = waterSources.find(item => item && item.id === system.water_source_id);
    for (const zone of system.zones) {
      if (!zone || typeof zone !== "object") continue;
      const profile = profiles.find(item => item && item.id === zone.soil_profile_id);
      const zoneCrops = Array.isArray(zone.crop_ids)
        ? zone.crop_ids.map(id => crops.find(crop => crop && crop.id === id)).filter(Boolean)
        : [];
      const spatialResult = spatialByZone.get(system.id + ":" + zone.id) ?? null;

      const cropAssessments = zoneCrops.map(crop => {
        const observationId = rootDepthObservationIds[crop.id];
        const rootZone = profile
          ? calculateRootZoneAvailableWater(profile, crop,
            observationId ? { observation_id: observationId } : {})
          : { status: "insufficient_inputs", reason: "linked_soil_profile_missing" };
        return Object.freeze({
          crop_id: crop.id,
          selected_root_depth_observation_id: observationId ?? null,
          root_zone_available_water: rootZone,
        });
      });

      const zoneFlow = zone.design_flow_m3_per_hour;
      const sourceFlow = source?.available_flow_m3_per_hour;
      let capacityComparison;
      if (!source) {
        capacityComparison = Object.freeze({
          status: "not_assessed",
          reason: system.water_source_id ? "water_source_reference_unresolved" : "water_source_not_linked",
        });
      } else if (!Number.isFinite(sourceFlow) || sourceFlow <= 0 ||
          !Number.isFinite(zoneFlow) || zoneFlow <= 0) {
        capacityComparison = Object.freeze({
          status: "not_assessed",
          reason: !Number.isFinite(sourceFlow) || sourceFlow <= 0
            ? "declared_source_flow_missing" : "zone_design_flow_missing",
        });
      } else {
        capacityComparison = Object.freeze({
          status: zoneFlow <= sourceFlow ? "declared_ratings_within_source_flow" : "declared_zone_flow_exceeds_source_flow",
          source_available_flow_m3_per_hour: sourceFlow,
          zone_design_flow_m3_per_hour: zoneFlow,
          comparison: "single_zone_declared_nameplate_flow_vs_declared_source_flow",
        });
      }

      const qualitySamples = Array.isArray(source?.quality_samples) ? source.quality_samples : [];
      const qualityEvidence = Object.freeze(qualitySamples.map(sample => Object.freeze({
        sample_id: sample?.id ?? null,
        parameter: sample?.parameter ?? null,
        value: Number.isFinite(sample?.value) ? sample.value : null,
        unit: sample?.unit ?? null,
        sampled_at: sample?.sampled_at ?? null,
        method: sample?.method ?? null,
        laboratory: sample?.laboratory ?? null,
        evidence_ref: sample?.evidence_ref ?? null,
        provenance_complete: Boolean(sample?.method && sample?.laboratory && sample?.evidence_ref),
      })));

      const evidenceRefs = new Set();
      const add = value => { if (typeof value === "string" && value) evidenceRefs.add(value); };
      add(system.evidence_ref);
      add(zone.evidence_ref);
      add(profile?.evidence_ref);
      add(source?.evidence_ref);
      for (const sample of profile?.samples ?? []) add(sample?.evidence_ref);
      for (const measurement of profile?.hydraulic_measurements ?? []) add(measurement?.evidence_ref);
      for (const crop of zoneCrops) {
        for (const observation of crop.root_depth_observations ?? []) add(observation?.evidence_ref);
      }
      for (const sample of qualitySamples) add(sample?.evidence_ref);

      zones.push(Object.freeze({
        irrigation_system_id: system.id,
        zone_id: zone.id,
        soil_profile_id: profile?.id ?? zone.soil_profile_id ?? null,
        crop_ids: Object.freeze(zoneCrops.map(crop => crop.id)),
        spatial_assessment: spatialResult,
        crop_root_zone_assessments: Object.freeze(cropAssessments),
        water_source: source ? Object.freeze({
          id: source.id,
          source_type: source.source_type ?? "unknown",
          available_flow_m3_per_hour: Number.isFinite(sourceFlow) ? sourceFlow : null,
          permitted_abstraction_m3_per_day: Number.isFinite(source.permitted_abstraction_m3_per_day)
            ? source.permitted_abstraction_m3_per_day : null,
          quality_sample_count: qualitySamples.length,
          quality_samples: qualityEvidence,
          quality_interpretation: "not_assessed",
        }) : null,
        declared_capacity_comparison: capacityComparison,
        evidence_refs: Object.freeze([...evidenceRefs].sort()),
      }));
    }
  }

  const allRootCalculations = zones.flatMap(zone => zone.crop_root_zone_assessments
    .map(item => item.root_zone_available_water));
  const rootCalculated = allRootCalculations.filter(item => item.status === "calculated").length;
  const rootInsufficient = allRootCalculations.length - rootCalculated;
  const capacityFlags = zones.filter(zone =>
    zone.declared_capacity_comparison.status === "declared_zone_flow_exceeds_source_flow").length;
  const unassessedSpatial = zones.filter(zone =>
    zone.spatial_assessment?.status !== "geometric_relationships_assessed").length;

  return Object.freeze({
    status: zones.length ? "evidence_consolidated_with_limits" : "insufficient_inputs",
    site_id: site?.site_id ?? null,
    summary: Object.freeze({
      irrigation_zone_count: zones.length,
      spatially_unassessed_zone_count: unassessedSpatial,
      root_zone_calculations_completed: rootCalculated,
      root_zone_calculations_insufficient: rootInsufficient,
      declared_flow_comparisons_flagged: capacityFlags,
    }),
    zones: Object.freeze(zones),
    decision_status: Object.freeze({
      water_quality_suitability: "not_assessed",
      crop_water_demand: "not_assessed",
      irrigation_schedule: "not_assessed",
      engineering_review: "not_started",
      operational_approval: "not_granted",
      model_applicability: "not_assessed",
    }),
    limitations: Object.freeze([
      "declared_source_flow_comparison_is_not_a_hydraulic_network_or_water_rights_assessment",
      "zone_flow_comparison_is_not_simultaneous_demand_or_all_zones_capacity_analysis",
      "permitted_daily_abstraction_is_reported_without_assuming_pumping_hours",
      "water_quality_samples_are_provenance_records_not_suitability_interpretations",
      "soil_and_root_zone_calculations_do_not_establish_sample_representativeness",
      "no_crop_demand_or_irrigation_schedule_is_calculated",
      "missing_or_ambiguous_inputs_remain_unassessed",
    ]),
  });
}
