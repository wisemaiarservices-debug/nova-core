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
