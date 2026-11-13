const TIMEZONE = /(Z|[+-]\d{2}:\d{2})$/;

function validMeasurement(item) {
  return item && typeof item === "object" && !Array.isArray(item) &&
    typeof item.value === "number" && Number.isFinite(item.value) &&
    typeof item.unit === "string" && Number.isFinite(item.top_depth_cm) &&
    Number.isFinite(item.bottom_depth_cm) && item.bottom_depth_cm > item.top_depth_cm;
}

function volumetricFraction(item) {
  if (["m3/m3", "cm3/cm3"].includes(item.unit)) return item.value;
  return null;
}

function gravimetricFraction(item) {
  if (["kg/kg", "g/g"].includes(item.unit)) return item.value;
  return null;
}

function bulkDensityKgM3(item) {
  if (item.unit === "kg/m3") return item.value;
  if (item.unit === "g/cm3") return item.value * 1000;
  return null;
}

/**
 * Deterministic plant-available-water depth for one explicitly requested layer.
 * This is a physical calculation only, not an irrigation recommendation.
 */
export function calculatePlantAvailableWater(profile, { top_depth_cm, bottom_depth_cm } = {}) {
  const insufficient = (reason, details = {}) => ({
    status: "insufficient_inputs", reason, ...details,
  });
  if (!profile || !Array.isArray(profile.hydraulic_measurements)) {
    return insufficient("hydraulic_measurements_missing");
  }
  if (!Number.isFinite(top_depth_cm) || !Number.isFinite(bottom_depth_cm) ||
      top_depth_cm < 0 || bottom_depth_cm <= top_depth_cm) {
    return insufficient("requested_depth_interval_invalid");
  }
  const matching = profile.hydraulic_measurements.filter(item =>
    validMeasurement(item) && item.top_depth_cm === top_depth_cm &&
    item.bottom_depth_cm === bottom_depth_cm);
  const fieldCapacity = matching.filter(item => item.parameter === "field_capacity");
  const wiltingPoint = matching.filter(item => item.parameter === "wilting_point");
  if (fieldCapacity.length !== 1 || wiltingPoint.length !== 1) {
    return insufficient("field_capacity_or_wilting_point_missing_or_ambiguous");
  }
  const fc = fieldCapacity[0], pwp = wiltingPoint[0];
  const fcVol = volumetricFraction(fc), pwpVol = volumetricFraction(pwp);
  let fcTheta, pwpTheta, basis;
  if (fcVol !== null && pwpVol !== null) {
    fcTheta = fcVol;
    pwpTheta = pwpVol;
    basis = "volumetric";
  } else {
    const fcGrav = gravimetricFraction(fc), pwpGrav = gravimetricFraction(pwp);
    if (fcGrav === null || pwpGrav === null) {
      return insufficient("water_content_units_incompatible_or_unsupported");
    }
    const densities = matching.filter(item => item.parameter === "bulk_density");
    if (densities.length !== 1) return insufficient("matching_bulk_density_missing_or_ambiguous");
    const density = bulkDensityKgM3(densities[0]);
    if (density === null || density <= 0) return insufficient("bulk_density_unit_unsupported");
    fcTheta = fcGrav * density / 1000;
    pwpTheta = pwpGrav * density / 1000;
    basis = "gravimetric_converted_with_bulk_density";
  }
  if ([fcTheta, pwpTheta].some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    return insufficient("converted_water_content_out_of_physical_range");
  }
  if (fcTheta < pwpTheta) return insufficient("field_capacity_below_wilting_point");
  const availableWaterMm = Math.round((fcTheta - pwpTheta) * (bottom_depth_cm - top_depth_cm) * 10 * 1e9) / 1e9;
  if (!Number.isFinite(availableWaterMm) || availableWaterMm < 0) {
    return insufficient("calculation_not_finite");
  }
  return {
    status: "calculated",
    quantity: "plant_available_water",
    value: availableWaterMm,
    unit: "mm",
    depth_interval_cm: { top: top_depth_cm, bottom: bottom_depth_cm },
    water_content_basis: basis,
    evidence_refs: [...new Set([fc.evidence_ref, pwp.evidence_ref,
      ...(basis === "volumetric" ? [] : matching.find(item => item.parameter === "bulk_density")?.evidence_ref ? [matching.find(item => item.parameter === "bulk_density").evidence_ref] : [])].filter(Boolean))],
    advisory: "Deterministic layer calculation only; not an irrigation schedule or crop recommendation.",
  };
}


/**
 * Aggregates measured/model-labelled layer calculations to one explicitly
 * selected crop root-depth observation. Requires complete, contiguous coverage
 * from the soil surface to the observed root depth; never extrapolates.
 */
export function calculateRootZoneAvailableWater(profile, crop, { observation_id } = {}) {
  const insufficient = (reason, details = {}) => ({ status: "insufficient_inputs", reason, ...details });
  if (!profile || !Array.isArray(profile.hydraulic_measurements)) {
    return insufficient("hydraulic_measurements_missing");
  }
  if (!crop || !Array.isArray(crop.root_depth_observations)) {
    return insufficient("root_depth_observations_missing");
  }
  const observations = crop.root_depth_observations.filter(item =>
    item && typeof item === "object" && (!observation_id || item.id === observation_id));
  if (observations.length !== 1) {
    return insufficient(observation_id ? "root_depth_observation_not_found_or_ambiguous" : "root_depth_observation_selection_required");
  }
  const observation = observations[0];
  if (!Number.isFinite(observation.root_depth_cm) || observation.root_depth_cm <= 0) {
    return insufficient("root_depth_value_invalid");
  }
  const intervals = [...new Map(profile.hydraulic_measurements
    .filter(validMeasurement)
    .filter(item => item.parameter === "field_capacity" || item.parameter === "wilting_point")
    .map(item => [item.top_depth_cm + ":" + item.bottom_depth_cm, {
      top_depth_cm: item.top_depth_cm, bottom_depth_cm: item.bottom_depth_cm,
    }])).values()]
    .sort((a, b) => a.top_depth_cm - b.top_depth_cm);
  const layers = [];
  let cursor = 0;
  for (const interval of intervals) {
    if (interval.bottom_depth_cm <= cursor) continue;
    if (interval.top_depth_cm !== cursor || interval.bottom_depth_cm > observation.root_depth_cm) {
      if (interval.top_depth_cm > cursor || interval.bottom_depth_cm > observation.root_depth_cm) break;
      continue;
    }
    const result = calculatePlantAvailableWater(profile, interval);
    if (result.status !== "calculated") {
      return insufficient("soil_layer_calculation_incomplete", { layer: interval, detail: result.reason });
    }
    layers.push(result);
    cursor = interval.bottom_depth_cm;
    if (cursor === observation.root_depth_cm) break;
  }
  if (cursor !== observation.root_depth_cm || layers.length === 0) {
    return insufficient("soil_profile_does_not_cover_root_depth", {
      covered_depth_cm: cursor, required_root_depth_cm: observation.root_depth_cm,
    });
  }
  const value = Math.round(layers.reduce((sum, layer) => sum + layer.value, 0) * 1e9) / 1e9;
  return {
    status: "calculated",
    quantity: "root_zone_plant_available_water",
    value,
    unit: "mm",
    crop_id: crop.id,
    root_depth_observation_id: observation.id,
    root_depth_cm: observation.root_depth_cm,
    growth_stage: observation.growth_stage,
    source_type: observation.source_type,
    evidence_refs: [...new Set([
      observation.evidence_ref,
      ...layers.flatMap(layer => layer.evidence_refs),
    ].filter(Boolean))],
    layers,
    advisory: "Evidence-gated root-zone calculation only; not crop demand, irrigation scheduling or a recommendation.",
  };
}
