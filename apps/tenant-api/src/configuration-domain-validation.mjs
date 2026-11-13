const ROOT_KEYS = new Set(["tenant", "site", "inventory", "calibration_records", "evidence", "extensions"]);
const TENANT_KEYS = new Set(["tenant_id"]);
const SITE_KEYS = new Set(["site_id", "timezone", "land_area", "boundary", "crops", "soil_profiles", "water_sources", "irrigation_systems", "energy_systems", "metadata"]);
const INVENTORY_KEYS = new Set(["equipment", "sensors", "gateways"]);
const CALIBRATION_KEYS = new Set(["id", "scope", "scope_id", "unit", "method", "effective_from", "effective_to", "certificate_number", "issuer", "issued_at", "evidence_ref"]); 
const EVIDENCE_KEYS = new Set(["id", "source_class", "reference", "observed_at", "issuer", "digest"]);
const RECORD_KEYS = {
  crops: new Set(["id", "species", "cultivar", "growth_stage", "planting_date", "expected_harvest_date", "root_depth_observations", "evidence_ref"]),
  water_sources: new Set(["id", "source_type", "name", "available_flow_m3_per_hour", "permitted_abstraction_m3_per_day", "quality_samples", "evidence_ref"]),
  soil_profiles: new Set(["id", "name", "classification_system", "classification", "horizons", "samples", "hydraulic_measurements", "evidence_ref"]),
  irrigation_systems: new Set(["id", "method", "water_source", "water_source_id", "design_flow_m3_per_hour", "controller_id", "pump_id", "control_protocol", "zones", "evidence_ref"]),
  energy_systems: new Set(["id", "type", "pv_capacity_kw", "inverter_capacity_kw", "battery_capacity_kwh", "battery_power_kw", "nominal_voltage_v", "grid_phase", "grid_connected", "inverter_id", "battery_id", "pv_equipment_id", "pv_strings", "design_min_temperature_c", "design_max_temperature_c", "battery_min_voltage_v", "battery_max_voltage_v", "battery_charge_power_kw", "battery_discharge_power_kw", "grid_export_limit_kw", "grid_import_limit_kw", "evidence_ref"]),
  equipment: new Set(["id", "manufacturer", "model", "protocol", "asset_class", "serial_number", "ratings", "rated_voltage_v", "rated_power_kw", "rated_flow_m3_per_hour", "phase", "pv_voc_v", "pv_vmp_v", "pv_isc_a", "pv_imp_a", "pv_power_w", "battery_capacity_kwh", "voc_temp_coefficient_pct_per_c", "vmp_temp_coefficient_pct_per_c", "inverter_max_input_voltage_v", "inverter_mppt_min_voltage_v", "inverter_mppt_max_voltage_v", "inverter_max_input_current_a", "inverter_max_short_circuit_current_a", "battery_min_voltage_v", "battery_max_voltage_v", "battery_max_charge_power_kw", "battery_max_discharge_power_kw", "inverter_max_battery_charge_power_kw", "inverter_max_battery_discharge_power_kw", "evidence_ref"]),
  sensors: new Set(["id", "manufacturer", "model", "protocol", "measurements", "connectivity_status", "gateway_id", "calibration_record_id", "evidence_ref"]),
  gateways: new Set(["id", "manufacturer", "model", "protocol", "supported_protocols", "connectivity_status", "evidence_ref"]),
};
const PROTOCOLS = new Set(["modbus_tcp", "modbus_rtu", "mqtt", "http_rest", "opc_ua", "lorawan", "bacnet_ip", "can_bus", "serial", "manual", "unknown"]);
const AREA_UNITS = new Set(["m2", "ha", "km2", "acre"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function issue(code, path, severity = "information_required") {
  return { code, path, severity };
}
function unknownKeys(value, allowed, path, issues) {
  if (!plainObject(value)) return;
  for (const key of Object.keys(value)) if (!allowed.has(key)) {
    issues.push(issue("field.unsupported", path + "." + key, "verification_required"));
  }
}
function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function validDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validateGeoJSON(boundary, path, errors) {
  if (!plainObject(boundary) || !["Polygon", "MultiPolygon", "Feature"].includes(boundary.type) ||
      !plainObject(boundary.geometry) && boundary.type === "Feature") {
    errors.push(issue("geometry.invalid_structure", path, "verification_required"));
    return;
  }
  const geometry = boundary.type === "Feature" ? boundary.geometry : boundary;
  if (!plainObject(geometry) || !["Polygon", "MultiPolygon"].includes(geometry.type) ||
      !Array.isArray(geometry.coordinates) || !boundary.crs ||
      typeof boundary.crs !== "string" || !boundary.crs.trim()) {
    errors.push(issue("geometry.crs_or_coordinates_missing", path, "information_required"));
    return;
  }
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat(1);
  const geographic = /^(EPSG:4326|urn:ogc:def:crs:OGC:1\.3:CRS84|OGC:CRS84)$/i.test(boundary.crs.trim());
  const invalidRing = ring => {
    if (!Array.isArray(ring) || ring.length < 4 ||
        ring.some(point => !Array.isArray(point) || point.length < 2 ||
          !point.slice(0, 2).every(n => typeof n === "number" && Number.isFinite(n))) ||
        JSON.stringify(ring[0]) !== JSON.stringify(ring[ring.length - 1])) return true;
    const unique = new Set(ring.slice(0, -1).map(point => JSON.stringify(point.slice(0, 2))));
    if (unique.size < 3) return true;
    let twiceArea = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      twiceArea += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    if (Math.abs(twiceArea) < Number.EPSILON) return true;
    if (geographic && ring.some(([longitude, latitude]) =>
      longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90)) return true;
    return false;
  };
  if (!rings.length || rings.some(invalidRing)) {
    errors.push(issue("geometry.invalid_ring", path, "verification_required"));
  }
}
function validateUniqueRecords(records, path, errors) {
  if (!Array.isArray(records)) {
    errors.push(issue("collection.invalid_type", path, "verification_required"));
    return [];
  }
  const ids = new Set();
  records.forEach((record, index) => {
    const id = record?.id;
    if (typeof id !== "string" || !TOKEN.test(id) || ids.has(id)) {
      errors.push(issue("record.id_missing_or_duplicate", path + "[" + index + "].id", "verification_required"));
    } else ids.add(id);
  });
  return records;
}

/**
 * Structural validation is intentionally separate from evidence, operational
 * approval and model applicability. Missing client specifications remain
 * missing; declarations never become observed telemetry.
 */
export function assessDomainConfiguration(payload, { assessedOn = new Date().toISOString().slice(0, 10) } = {}) {
  const errors = [];
  const issues = [];
  const waterSourceIds = new Set();
  if (!plainObject(payload)) {
    return Object.freeze({ valid: false, errors: [issue("configuration.root_invalid", "$", "verification_required")],
      issues: [], status: Object.freeze({ structural_validity: "invalid", evidence_readiness: "not_assessed",
        operational_review: "not_started", model_applicability: "not_assessed" }) });
  }
  unknownKeys(payload, ROOT_KEYS, "$", issues);
  unknownKeys(payload.tenant, TENANT_KEYS, "tenant", issues);
  if (!plainObject(payload.tenant) || typeof payload.tenant.tenant_id !== "string" ||
      !TOKEN.test(payload.tenant.tenant_id)) {
    errors.push(issue("tenant.identity_required", "tenant.tenant_id", "information_required"));
  }
  if (!plainObject(payload.site) || typeof payload.site.site_id !== "string" ||
      !TOKEN.test(payload.site.site_id)) {
    errors.push(issue("site.identity_required", "site.site_id", "information_required"));
  } else {
    unknownKeys(payload.site, SITE_KEYS, "site", issues);
    if (typeof payload.site.timezone !== "string" || !payload.site.timezone.trim()) {
      issues.push(issue("site.timezone_unknown", "site.timezone"));
    }
    const area = payload.site.land_area;
    if (area !== undefined && area !== null &&
        (!plainObject(area) || !finitePositive(area.value) || !AREA_UNITS.has(area.unit))) {
      errors.push(issue("site.land_area_invalid", "site.land_area", "verification_required"));
    } else if (!area) issues.push(issue("site.land_area_missing", "site.land_area"));
    if (payload.site.boundary !== undefined && payload.site.boundary !== null) {
      validateGeoJSON(payload.site.boundary, "site.boundary", errors);
    } else issues.push(issue("site.boundary_missing", "site.boundary"));
    const crops = validateUniqueRecords(payload.site.crops ?? [], "site.crops", errors);
    crops.forEach((crop, i) => {
      unknownKeys(crop, RECORD_KEYS.crops, "site.crops[" + i + "]", issues);
      if (crop?.root_depth_observations !== undefined) {
        if (!Array.isArray(crop.root_depth_observations)) {
          errors.push(issue("crop.root_depth_observations_invalid_type", "site.crops[" + i + "].root_depth_observations", "verification_required"));
        } else {
          const observationIds = new Set();
          crop.root_depth_observations.forEach((observation, observationIndex) => {
            const observationPath = "site.crops[" + i + "].root_depth_observations[" + observationIndex + "]";
            if (!plainObject(observation) || typeof observation.id !== "string" || !TOKEN.test(observation.id) || observationIds.has(observation.id)) {
              errors.push(issue("crop.root_depth_observation_id_invalid", observationPath + ".id", "verification_required"));
              return;
            }
            observationIds.add(observation.id);
            unknownKeys(observation, new Set(["id", "root_depth_cm", "growth_stage", "source_type", "method", "observed_at", "evidence_ref"]), observationPath, issues);
            if (!finitePositive(observation.root_depth_cm)) {
              errors.push(issue("crop.root_depth_value_invalid", observationPath + ".root_depth_cm", "verification_required"));
            }
            if (!["measured", "laboratory", "modelled"].includes(observation.source_type)) {
              issues.push(issue("crop.root_depth_source_unverified", observationPath + ".source_type", "verification_required"));
            }
            if (typeof observation.method !== "string" || !observation.method.trim()) {
              issues.push(issue("crop.root_depth_method_missing", observationPath + ".method", "verification_required"));
            }
            if (typeof observation.growth_stage !== "string" || !observation.growth_stage.trim()) {
              issues.push(issue("crop.root_depth_growth_stage_missing", observationPath + ".growth_stage", "verification_required"));
            }
            const observedAt = typeof observation.observed_at === "string"
              ? observation.observed_at.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
              : null;
            const year = observedAt ? Number(observedAt[1]) : 0;
            const month = observedAt ? Number(observedAt[2]) : 0;
            const day = observedAt ? Number(observedAt[3]) : 0;
            const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
            const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
            if (!observedAt || month < 1 || month > 12 || day < 1 || !days || day > days || !Number.isFinite(Date.parse(observation.observed_at))) {
              errors.push(issue("crop.root_depth_timestamp_invalid", observationPath + ".observed_at", "verification_required"));
            }
            if (!observation.evidence_ref) issues.push(issue("crop.root_depth_evidence_missing", observationPath + ".evidence_ref", "verification_required"));
          });
        }
      }
      if (!plainObject(crop) || typeof crop.species !== "string" || !crop.species.trim()) {
        errors.push(issue("crop.species_required", "site.crops[" + i + "].species", "verification_required"));
      }
      if (crop?.planting_date && !validDate(crop.planting_date)) errors.push(issue("crop.planting_date_invalid", "site.crops[" + i + "].planting_date", "verification_required"));
      if (crop?.expected_harvest_date && !validDate(crop.expected_harvest_date)) errors.push(issue("crop.harvest_date_invalid", "site.crops[" + i + "].expected_harvest_date", "verification_required"));
      if (crop?.planting_date && crop?.expected_harvest_date && validDate(crop.planting_date) && validDate(crop.expected_harvest_date) &&
          crop.expected_harvest_date < crop.planting_date) errors.push(issue("crop.date_order_invalid", "site.crops[" + i + "]", "verification_required"));
    });
    if (!crops.length) issues.push(issue("site.crops_missing", "site.crops"));
    const soilProfiles = validateUniqueRecords(payload.site.soil_profiles ?? [], "site.soil_profiles", errors);
    soilProfiles.forEach((profile, profileIndex) => {
      const profilePath = "site.soil_profiles[" + profileIndex + "]";
      unknownKeys(profile, RECORD_KEYS.soil_profiles, profilePath, issues);
      if (!plainObject(profile)) {
        errors.push(issue("soil_profile.record_invalid", profilePath, "verification_required"));
        return;
      }
      if (profile.name !== undefined && (typeof profile.name !== "string" || !profile.name.trim())) {
        errors.push(issue("soil_profile.name_invalid", profilePath + ".name", "verification_required"));
      }
      if (profile.classification_system && !profile.classification) {
        issues.push(issue("soil_profile.classification_missing", profilePath + ".classification", "verification_required"));
      }
      const hydraulicMeasurements = profile.hydraulic_measurements ?? [];
      if (!Array.isArray(hydraulicMeasurements)) {
        errors.push(issue("soil_hydraulic.measurements_invalid_type", profilePath + ".hydraulic_measurements", "verification_required"));
      } else {
        const measurementIds = new Set();
        hydraulicMeasurements.forEach((measurement, measurementIndex) => {
          const measurementPath = profilePath + ".hydraulic_measurements[" + measurementIndex + "]";
          if (!plainObject(measurement) || typeof measurement.id !== "string" || !TOKEN.test(measurement.id) || measurementIds.has(measurement.id)) {
            errors.push(issue("soil_hydraulic.id_missing_or_duplicate", measurementPath + ".id", "verification_required"));
            return;
          }
          measurementIds.add(measurement.id);
          unknownKeys(measurement, new Set(["id", "parameter", "value", "unit", "top_depth_cm", "bottom_depth_cm", "source_type", "method", "sampled_at", "evidence_ref"]), measurementPath, issues);
          if (!["field_capacity", "wilting_point", "bulk_density"].includes(measurement.parameter)) {
            errors.push(issue("soil_hydraulic.parameter_invalid", measurementPath + ".parameter", "verification_required"));
          }
          if (typeof measurement.value !== "number" || !Number.isFinite(measurement.value) || measurement.value < 0 ||
              typeof measurement.unit !== "string" || !measurement.unit.trim()) {
            errors.push(issue("soil_hydraulic.value_or_unit_invalid", measurementPath, "verification_required"));
          }
          if (typeof measurement.top_depth_cm !== "number" || !Number.isFinite(measurement.top_depth_cm) || measurement.top_depth_cm < 0 ||
              typeof measurement.bottom_depth_cm !== "number" || !Number.isFinite(measurement.bottom_depth_cm) || measurement.bottom_depth_cm <= measurement.top_depth_cm) {
            errors.push(issue("soil_hydraulic.depth_interval_invalid", measurementPath, "verification_required"));
          }
          if (!["measured", "laboratory", "modelled"].includes(measurement.source_type)) {
            issues.push(issue("soil_hydraulic.source_type_unverified", measurementPath + ".source_type", "verification_required"));
          }
          if (typeof measurement.method !== "string" || !measurement.method.trim()) {
            issues.push(issue("soil_hydraulic.method_missing", measurementPath + ".method", "verification_required"));
          }
          const hydraulicTimestamp = typeof measurement.sampled_at === "string"
            ? measurement.sampled_at.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
            : null;
          const timestampYear = hydraulicTimestamp ? Number(hydraulicTimestamp[1]) : 0;
          const timestampMonth = hydraulicTimestamp ? Number(hydraulicTimestamp[2]) : 0;
          const timestampDay = hydraulicTimestamp ? Number(hydraulicTimestamp[3]) : 0;
          const timestampLeap = timestampYear % 4 === 0 && (timestampYear % 100 !== 0 || timestampYear % 400 === 0);
          const timestampMonthDays = [31, timestampLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][timestampMonth - 1];
          if (!hydraulicTimestamp || timestampMonth < 1 || timestampMonth > 12 || timestampDay < 1 ||
              !timestampMonthDays || timestampDay > timestampMonthDays || !Number.isFinite(Date.parse(measurement.sampled_at))) {
            errors.push(issue("soil_hydraulic.timestamp_invalid", measurementPath + ".sampled_at", "verification_required"));
          }
          if (!measurement.evidence_ref) issues.push(issue("soil_hydraulic.evidence_missing", measurementPath + ".evidence_ref", "verification_required"));
          if (measurement.parameter === "field_capacity" || measurement.parameter === "wilting_point") {
            const volumetric = ["m3/m3", "cm3/cm3"].includes(measurement.unit);
            const gravimetric = ["kg/kg", "g/g"].includes(measurement.unit);
            if (!volumetric && !gravimetric) issues.push(issue("soil_hydraulic.water_content_unit_unsupported", measurementPath + ".unit", "verification_required"));
            if (volumetric && measurement.value > 1) {
              errors.push(issue("soil_hydraulic.water_content_out_of_range", measurementPath + ".value", "verification_required"));
            }
          }
          if (measurement.parameter === "bulk_density" && !["g/cm3", "kg/m3"].includes(measurement.unit)) {
            issues.push(issue("soil_hydraulic.bulk_density_unit_unsupported", measurementPath + ".unit", "verification_required"));
          }
        });
      }
      const horizons = profile.horizons ?? [];
      if (!Array.isArray(horizons)) {
        errors.push(issue("soil_profile.horizons_invalid_type", profilePath + ".horizons", "verification_required"));
      } else {
        const horizonIds = new Set();
        const intervals = [];
        horizons.forEach((horizon, horizonIndex) => {
          const horizonPath = profilePath + ".horizons[" + horizonIndex + "]";
          if (!plainObject(horizon) || typeof horizon.id !== "string" || !TOKEN.test(horizon.id) || horizonIds.has(horizon.id)) {
            errors.push(issue("soil_horizon.id_missing_or_duplicate", horizonPath + ".id", "verification_required"));
            return;
          }
          horizonIds.add(horizon.id);
          unknownKeys(horizon, new Set(["id", "name", "top_depth_cm", "bottom_depth_cm", "texture", "classification", "evidence_ref"]), horizonPath, issues);
          const top = horizon.top_depth_cm;
          const bottom = horizon.bottom_depth_cm;
          if (typeof top !== "number" || !Number.isFinite(top) || top < 0 ||
              typeof bottom !== "number" || !Number.isFinite(bottom) || bottom <= top) {
            errors.push(issue("soil_horizon.depth_interval_invalid", horizonPath, "verification_required"));
          } else intervals.push({ top, bottom, path: horizonPath });
        });
        intervals.sort((a, b) => a.top - b.top);
        for (let i = 1; i < intervals.length; i++) {
          if (intervals[i].top < intervals[i - 1].bottom) {
            errors.push(issue("soil_horizon.depth_overlap", intervals[i].path, "verification_required"));
          }
        }
      }
      const samples = profile.samples ?? [];
      if (!Array.isArray(samples)) {
        errors.push(issue("soil_profile.samples_invalid_type", profilePath + ".samples", "verification_required"));
      } else {
        const sampleIds = new Set();
        samples.forEach((sample, sampleIndex) => {
          const samplePath = profilePath + ".samples[" + sampleIndex + "]";
          if (!plainObject(sample) || typeof sample.id !== "string" || !TOKEN.test(sample.id) || sampleIds.has(sample.id)) {
            errors.push(issue("soil_sample.id_missing_or_duplicate", samplePath + ".id", "verification_required"));
            return;
          }
          sampleIds.add(sample.id);
          unknownKeys(sample, new Set(["id", "sampling_point", "top_depth_cm", "bottom_depth_cm", "sampled_at", "method", "laboratory", "analytes", "evidence_ref"]), samplePath, issues);
          if (typeof sample.top_depth_cm !== "number" || !Number.isFinite(sample.top_depth_cm) || sample.top_depth_cm < 0 ||
              typeof sample.bottom_depth_cm !== "number" || !Number.isFinite(sample.bottom_depth_cm) ||
              sample.bottom_depth_cm <= sample.top_depth_cm) {
            errors.push(issue("soil_sample.depth_interval_invalid", samplePath, "verification_required"));
          }
          if (sample.sampling_point !== undefined) {
            const point = sample.sampling_point;
            if (!plainObject(point) || point.crs !== "EPSG:4326" || !Array.isArray(point.coordinates) ||
                point.coordinates.length !== 2 || !point.coordinates.every(Number.isFinite) ||
                point.coordinates[0] < -180 || point.coordinates[0] > 180 ||
                point.coordinates[1] < -90 || point.coordinates[1] > 90) {
              errors.push(issue("soil_sample.sampling_point_invalid", samplePath + ".sampling_point", "verification_required"));
            }
          }
          const timestampMatch = typeof sample.sampled_at === "string"
            ? sample.sampled_at.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
            : null;
          const year = timestampMatch ? Number(timestampMatch[1]) : 0;
          const month = timestampMatch ? Number(timestampMatch[2]) : 0;
          const day = timestampMatch ? Number(timestampMatch[3]) : 0;
          const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
          const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
          if (!timestampMatch || month < 1 || month > 12 || day < 1 || !monthDays || day > monthDays ||
              !Number.isFinite(Date.parse(sample.sampled_at))) {
            errors.push(issue("soil_sample.timestamp_invalid", samplePath + ".sampled_at", "verification_required"));
          }
          if (typeof sample.method !== "string" || !sample.method.trim()) {
            issues.push(issue("soil_sample.method_missing", samplePath + ".method", "verification_required"));
          }
          if (typeof sample.laboratory !== "string" || !sample.laboratory.trim()) {
            issues.push(issue("soil_sample.laboratory_missing", samplePath + ".laboratory", "verification_required"));
          }
          if (!Array.isArray(sample.analytes) || sample.analytes.length === 0) {
            issues.push(issue("soil_sample.analytes_missing", samplePath + ".analytes", "verification_required"));
          } else {
            sample.analytes.forEach((analyte, analyteIndex) => {
              const analytePath = samplePath + ".analytes[" + analyteIndex + "]";
              if (!plainObject(analyte) || typeof analyte.parameter !== "string" || !analyte.parameter.trim() ||
                  typeof analyte.value !== "number" || !Number.isFinite(analyte.value) ||
                  typeof analyte.unit !== "string" || !analyte.unit.trim()) {
                errors.push(issue("soil_sample.analyte_invalid", analytePath, "verification_required"));
              }
              if (plainObject(analyte)) unknownKeys(analyte, new Set(["parameter", "value", "unit", "method", "evidence_ref"]), analytePath, issues);
              if (plainObject(analyte) && !analyte.method && !sample.method) {
                issues.push(issue("soil_sample.analyte_method_missing", analytePath + ".method", "verification_required"));
              }
            });
          }
          if (!sample.evidence_ref) issues.push(issue("soil_sample.evidence_missing", samplePath + ".evidence_ref", "verification_required"));
        });
      }
    });
    const waterSources = validateUniqueRecords(payload.site.water_sources ?? [], "site.water_sources", errors);
    waterSources.forEach((source, index) => {
      const path = "site.water_sources[" + index + "]";
      unknownKeys(source, RECORD_KEYS.water_sources, path, issues);
      if (!plainObject(source)) {
        errors.push(issue("water_source.record_invalid", path, "verification_required"));
        return;
      }
      waterSourceIds.add(source.id);
      if (source.source_type !== undefined && !["groundwater", "surface_water", "rainwater", "municipal", "reclaimed_water", "desalinated", "unknown"].includes(source.source_type)) {
        issues.push(issue("water_source.type_unrecognized", path + ".source_type", "verification_required"));
      } else if (source.source_type === undefined || source.source_type === "unknown") {
        issues.push(issue("water_source.type_unknown", path + ".source_type", "verification_required"));
      }
      for (const key of ["available_flow_m3_per_hour", "permitted_abstraction_m3_per_day"]) {
        if (source[key] !== undefined && source[key] !== null && !finitePositive(source[key])) {
          errors.push(issue("engineering.rating_must_be_positive", path + "." + key, "verification_required"));
        }
      }
      if (source.quality_samples !== undefined) {
        if (!Array.isArray(source.quality_samples)) {
          errors.push(issue("water_source.quality_samples_invalid_type", path + ".quality_samples", "verification_required"));
        } else {
          const sampleIds = new Set();
          source.quality_samples.forEach((sample, sampleIndex) => {
            const samplePath = path + ".quality_samples[" + sampleIndex + "]";
            if (!plainObject(sample) || typeof sample.id !== "string" || !TOKEN.test(sample.id) || sampleIds.has(sample.id)) {
              errors.push(issue("water_quality.sample_id_missing_or_duplicate", samplePath + ".id", "verification_required"));
              return;
            }
            sampleIds.add(sample.id);
            unknownKeys(sample, new Set(["id", "parameter", "value", "unit", "sampled_at", "method", "laboratory", "evidence_ref"]), samplePath, issues);
            if (typeof sample.parameter !== "string" || !sample.parameter.trim()) {
              errors.push(issue("water_quality.parameter_required", samplePath + ".parameter", "verification_required"));
            }
            if (typeof sample.value !== "number" || !Number.isFinite(sample.value)) {
              errors.push(issue("water_quality.value_invalid", samplePath + ".value", "verification_required"));
            }
            if (typeof sample.unit !== "string" || !sample.unit.trim()) {
              errors.push(issue("water_quality.unit_required", samplePath + ".unit", "verification_required"));
            }
            const timestampMatch = typeof sample.sampled_at === "string"
              ? sample.sampled_at.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
              : null;
            const timestampYear = timestampMatch ? Number(timestampMatch[1]) : 0;
            const timestampMonth = timestampMatch ? Number(timestampMatch[2]) : 0;
            const timestampDay = timestampMatch ? Number(timestampMatch[3]) : 0;
            const leapYear = timestampYear % 4 === 0 && (timestampYear % 100 !== 0 || timestampYear % 400 === 0);
            const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][timestampMonth - 1];
            if (!timestampMatch || timestampMonth < 1 || timestampMonth > 12 || timestampDay < 1 ||
                !daysInMonth || timestampDay > daysInMonth || !Number.isFinite(Date.parse(sample.sampled_at))) {
              errors.push(issue("water_quality.sample_timestamp_invalid", samplePath + ".sampled_at", "verification_required"));
            }
            if (typeof sample.method !== "string" || !sample.method.trim()) {
              issues.push(issue("water_quality.method_missing", samplePath + ".method", "verification_required"));
            }
            if (typeof sample.laboratory !== "string" || !sample.laboratory.trim()) {
              issues.push(issue("water_quality.laboratory_missing", samplePath + ".laboratory", "verification_required"));
            }
            if (!sample.evidence_ref) {
              issues.push(issue("water_quality.evidence_missing", samplePath + ".evidence_ref", "verification_required"));
            }
          });
        }
      }
    });
    for (const field of ["irrigation_systems", "energy_systems"]) {
      const list = validateUniqueRecords(payload.site[field] ?? [], "site." + field, errors);
      list.forEach((record, index) => {
        unknownKeys(record, RECORD_KEYS[field], "site." + field + "[" + index + "]", issues);
        if (!plainObject(record)) return;
        const positiveFields = field === "irrigation_systems"
          ? ["design_flow_m3_per_hour"]
          : ["pv_capacity_kw", "inverter_capacity_kw", "battery_capacity_kwh", "battery_power_kw", "nominal_voltage_v", "grid_export_limit_kw", "grid_import_limit_kw"];
        for (const key of positiveFields) {
          if (record[key] !== undefined && record[key] !== null && !finitePositive(record[key])) {
            errors.push(issue("engineering.rating_must_be_positive", "site." + field + "[" + index + "]." + key, "verification_required"));
          }
        }
        if (field === "energy_systems" && record.grid_connected !== undefined && typeof record.grid_connected !== "boolean") {
          errors.push(issue("energy.grid_connected_invalid", "site.energy_systems[" + index + "].grid_connected", "verification_required"));
        }
        if (field === "energy_systems" && record.grid_connected === false &&
            (record.grid_export_limit_kw !== undefined || record.grid_import_limit_kw !== undefined)) {
          issues.push(issue("energy.grid_limits_conflict_with_off_grid",
            "site.energy_systems[" + index + "]", "verification_required"));
        }
        if (field === "energy_systems" && record.grid_phase !== undefined &&
            !["single_phase", "three_phase", "dc", "unknown"].includes(record.grid_phase)) {
          errors.push(issue("energy.grid_phase_invalid", "site.energy_systems[" + index + "].grid_phase", "verification_required"));
        }
        if (field === "energy_systems" && record.pv_strings !== undefined) {
          if (!Array.isArray(record.pv_strings)) {
            errors.push(issue("energy.pv_strings_invalid_type", "site.energy_systems[" + index + "].pv_strings", "verification_required"));
          } else {
            const stringIds = new Set();
            record.pv_strings.forEach((pvString, stringIndex) => {
              const path = "site.energy_systems[" + index + "].pv_strings[" + stringIndex + "]";
              if (!plainObject(pvString) || typeof pvString.id !== "string" || !TOKEN.test(pvString.id) ||
                  stringIds.has(pvString.id)) {
                errors.push(issue("energy.pv_string_id_missing_or_duplicate", path + ".id", "verification_required"));
                return;
              }
              stringIds.add(pvString.id);
              unknownKeys(pvString, new Set(["id", "module_equipment_id", "inverter_id", "modules_per_string", "parallel_strings", "mppt_index"]), path, issues);
              for (const key of ["modules_per_string", "parallel_strings", "mppt_index"]) {
                if (pvString[key] !== undefined && (!Number.isInteger(pvString[key]) || pvString[key] <= 0)) {
                  errors.push(issue("energy.pv_string_integer_invalid", path + "." + key, "verification_required"));
                }
              }
              if (pvString.modules_per_string === undefined || pvString.parallel_strings === undefined) {
                issues.push(issue("energy.pv_string_configuration_incomplete", path, "verification_required"));
              }
            });
          }
        }
        if (field === "energy_systems") {
          for (const key of ["battery_min_voltage_v", "battery_max_voltage_v", "battery_charge_power_kw", "battery_discharge_power_kw"]) {
            if (record[key] !== undefined && !finitePositive(record[key])) {
              errors.push(issue("engineering.rating_must_be_positive", "site.energy_systems[" + index + "]." + key, "verification_required"));
            }
          }
          if (finitePositive(record.battery_min_voltage_v) && finitePositive(record.battery_max_voltage_v) &&
              record.battery_min_voltage_v > record.battery_max_voltage_v) {
            errors.push(issue("energy.battery_voltage_window_invalid", "site.energy_systems[" + index + "]", "verification_required"));
          }
        }
        for (const key of ["design_min_temperature_c", "design_max_temperature_c"]) {
          if (record[key] !== undefined && (typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] < -100 || record[key] > 100)) {
            errors.push(issue("energy.design_temperature_invalid", "site.energy_systems[" + index + "]." + key, "verification_required"));
          }
        }
        if (record.design_min_temperature_c !== undefined && record.design_max_temperature_c !== undefined &&
            record.design_min_temperature_c > record.design_max_temperature_c) {
          errors.push(issue("energy.design_temperature_order_invalid", "site.energy_systems[" + index + "]", "verification_required"));
        }
        if (field === "irrigation_systems") {
          if (record.water_source_id !== undefined && !waterSourceIds.has(record.water_source_id)) {
            issues.push(issue("irrigation.water_source_reference_unresolved", "site.irrigation_systems[" + index + "].water_source_id", "verification_required"));
          }
          if (record.control_protocol !== undefined && !PROTOCOLS.has(record.control_protocol)) {
            issues.push(issue("irrigation.control_protocol_unrecognized",
              "site.irrigation_systems[" + index + "].control_protocol", "verification_required"));
          }
          if (record.zones !== undefined) {
            if (!Array.isArray(record.zones)) {
              errors.push(issue("irrigation.zones_invalid_type", "site.irrigation_systems[" + index + "].zones", "verification_required"));
            } else {
              const zoneIds = new Set();
              record.zones.forEach((zone, zoneIndex) => {
                const zonePath = "site.irrigation_systems[" + index + "].zones[" + zoneIndex + "]";
                if (!plainObject(zone) || typeof zone.id !== "string" || !TOKEN.test(zone.id)) {
                  errors.push(issue("irrigation.zone_id_missing_or_duplicate", zonePath + ".id", "verification_required"));
                  return;
                }
                if (zoneIds.has(zone.id)) {
                  errors.push(issue("irrigation.zone_id_missing_or_duplicate", zonePath + ".id", "verification_required"));
                } else zoneIds.add(zone.id);
                unknownKeys(zone, new Set(["id", "pump_id", "controller_id", "design_flow_m3_per_hour", "area_ha", "soil_profile_id", "soil_horizon_id", "crop_ids"]), zonePath, issues);
                if (zone.crop_ids !== undefined) {
                  if (!Array.isArray(zone.crop_ids)) errors.push(issue("irrigation.zone_crop_ids_invalid_type", zonePath + ".crop_ids", "verification_required"));
                  else zone.crop_ids.forEach(cropId => {
                    if (!crops.some(crop => plainObject(crop) && crop.id === cropId)) {
                      issues.push(issue("irrigation.zone_crop_reference_unresolved", zonePath + ".crop_ids", "verification_required"));
                    }
                  });
                }
                if (zone.soil_profile_id !== undefined && !soilProfiles.some(profile => plainObject(profile) && profile.id === zone.soil_profile_id)) {
                  issues.push(issue("irrigation.zone_soil_profile_reference_unresolved", zonePath + ".soil_profile_id", "verification_required"));
                }
                if (zone.soil_horizon_id !== undefined) {
                  const linkedProfile = soilProfiles.find(profile => plainObject(profile) && profile.id === zone.soil_profile_id);
                  if (!linkedProfile || !Array.isArray(linkedProfile.horizons) || !linkedProfile.horizons.some(horizon => plainObject(horizon) && horizon.id === zone.soil_horizon_id)) {
                    issues.push(issue("irrigation.zone_soil_horizon_reference_unresolved", zonePath + ".soil_horizon_id", "verification_required"));
                  }
                }
                for (const key of ["design_flow_m3_per_hour", "area_ha"]) {
                  if (zone[key] !== undefined && zone[key] !== null && !finitePositive(zone[key])) {
                    errors.push(issue("engineering.rating_must_be_positive", zonePath + "." + key, "verification_required"));
                  }
                }
              });
            }
          }
        }
      });
      if (!list.length) issues.push(issue("site." + field + "_missing", "site." + field));
    }
  }
  if (payload.inventory !== undefined) {
    if (!plainObject(payload.inventory)) errors.push(issue("inventory.invalid_type", "inventory", "verification_required"));
    else {
      unknownKeys(payload.inventory, INVENTORY_KEYS, "inventory", issues);
      for (const kind of ["equipment", "sensors", "gateways"]) {
        const records = validateUniqueRecords(payload.inventory[kind] ?? [], "inventory." + kind, errors);
        records.forEach((record, i) => {
          if (!plainObject(record)) errors.push(issue("inventory.record_invalid", "inventory." + kind + "[" + i + "]", "verification_required"));
          else {
            unknownKeys(record, RECORD_KEYS[kind], "inventory." + kind + "[" + i + "]", issues);
            if (record.protocol !== undefined && !PROTOCOLS.has(record.protocol)) issues.push(issue("inventory.protocol_unrecognized", "inventory." + kind + "[" + i + "].protocol", "verification_required"));
            if (record.protocol === undefined || record.protocol === "unknown") issues.push(issue("inventory.protocol_unknown", "inventory." + kind + "[" + i + "].protocol", "verification_required"));
            if (kind === "gateways" && record.supported_protocols !== undefined) {
              if (!Array.isArray(record.supported_protocols) ||
                  record.supported_protocols.some(protocol => typeof protocol !== "string" || !PROTOCOLS.has(protocol) || protocol === "unknown")) {
                errors.push(issue("gateway.supported_protocols_invalid", "inventory.gateways[" + i + "].supported_protocols", "verification_required"));
              } else if (new Set(record.supported_protocols).size !== record.supported_protocols.length) {
                errors.push(issue("gateway.supported_protocols_duplicate", "inventory.gateways[" + i + "].supported_protocols", "verification_required"));
              }
            }
            if (kind === "equipment") {
              for (const key of ["rated_voltage_v", "rated_power_kw", "rated_flow_m3_per_hour", "pv_voc_v", "pv_vmp_v", "pv_isc_a", "pv_imp_a", "pv_power_w", "battery_capacity_kwh", "inverter_max_input_voltage_v", "inverter_mppt_min_voltage_v", "inverter_mppt_max_voltage_v", "inverter_max_input_current_a", "inverter_max_short_circuit_current_a"]) {
                if (record[key] !== undefined && record[key] !== null && !finitePositive(record[key])) {
                  errors.push(issue("engineering.rating_must_be_positive", "inventory.equipment[" + i + "]." + key, "verification_required"));
                }
              }
              for (const key of ["battery_min_voltage_v", "battery_max_voltage_v", "battery_max_charge_power_kw", "battery_max_discharge_power_kw", "inverter_max_battery_charge_power_kw", "inverter_max_battery_discharge_power_kw"]) {
                if (record[key] !== undefined && record[key] !== null && !finitePositive(record[key])) {
                  errors.push(issue("engineering.rating_must_be_positive", "inventory.equipment[" + i + "]." + key, "verification_required"));
                }
              }
              if (finitePositive(record.battery_min_voltage_v) && finitePositive(record.battery_max_voltage_v) &&
                  record.battery_min_voltage_v > record.battery_max_voltage_v) {
                errors.push(issue("energy.battery_voltage_window_invalid", "inventory.equipment[" + i + "]", "verification_required"));
              }
              if (finitePositive(record.inverter_mppt_min_voltage_v) && finitePositive(record.inverter_mppt_max_voltage_v) &&
                  record.inverter_mppt_min_voltage_v > record.inverter_mppt_max_voltage_v) {
                errors.push(issue("energy.inverter_mppt_window_invalid", "inventory.equipment[" + i + "]", "verification_required"));
              }
              for (const key of ["voc_temp_coefficient_pct_per_c", "vmp_temp_coefficient_pct_per_c"]) {
                if (record[key] !== undefined && (typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] >= 0 || record[key] < -2)) {
                  errors.push(issue("energy.pv_temperature_coefficient_invalid", "inventory.equipment[" + i + "]." + key, "verification_required"));
                }
              }
              if (record.phase !== undefined && !["single_phase", "three_phase", "dc", "unknown"].includes(record.phase)) {
                errors.push(issue("equipment.phase_invalid", "inventory.equipment[" + i + "].phase", "verification_required"));
              }
            }
            if (record.manufacturer === undefined || record.model === undefined) issues.push(issue("inventory.identity_incomplete", "inventory." + kind + "[" + i + "]"));
          }
        });
      }
    }
  } else issues.push(issue("inventory.not_supplied", "inventory"));
  if (payload.calibration_records !== undefined) {
    if (!Array.isArray(payload.calibration_records)) errors.push(issue("calibration.invalid_type", "calibration_records", "verification_required"));
    else payload.calibration_records.forEach((record, i) => {
      const path = "calibration_records[" + i + "]";
      unknownKeys(record, CALIBRATION_KEYS, path, issues);
      if (!plainObject(record) || typeof record.id !== "string" || !TOKEN.test(record.id) ||
          !["site", "asset", "sensor"].includes(record.scope) ||
          typeof record.scope_id !== "string" || !TOKEN.test(record.scope_id) ||
          typeof record.unit !== "string" || !record.unit.trim() ||
          typeof record.method !== "string" || !record.method.trim() ||
          !validDate(record.effective_from) ||
          (record.effective_to !== undefined && record.effective_to !== null && !validDate(record.effective_to)) ||
          (record.effective_to && record.effective_to < record.effective_from)) {
        errors.push(issue("calibration.record_invalid", path, "verification_required"));
      }
      if (record?.parameter_scope === "global_model" || record?.scope === "global_model") {
        errors.push(issue("calibration.global_model_parameter_forbidden", path, "verification_required"));
      }
      if (!record?.evidence_ref) issues.push(issue("calibration.evidence_missing", path + ".evidence_ref", "verification_required"));
      if (plainObject(record)) {
        if (typeof record.certificate_number !== "string" || !record.certificate_number.trim()) {
          issues.push(issue("calibration.certificate_number_missing", path + ".certificate_number", "verification_required"));
        }
        if (typeof record.issuer !== "string" || !record.issuer.trim()) {
          issues.push(issue("calibration.issuer_missing", path + ".issuer", "verification_required"));
        }
        if (!validDate(record.issued_at)) {
          issues.push(issue("calibration.issued_at_missing_or_invalid", path + ".issued_at", "verification_required"));
        } else if (validDate(record.effective_from) && record.issued_at > record.effective_from) {
          issues.push(issue("calibration.certificate_issued_after_effective_date", path + ".issued_at", "verification_required"));
        }
        if (validDate(assessedOn) && validDate(record.effective_from) && record.effective_from > assessedOn) {
          issues.push(issue("calibration.not_yet_effective", path + ".effective_from", "verification_required"));
        }
        if (validDate(assessedOn) && validDate(record.effective_to) && record.effective_to < assessedOn) {
          issues.push(issue("calibration.expired", path + ".effective_to", "verification_required"));
        }
        if (validDate(assessedOn) && validDate(record.issued_at) && record.issued_at > assessedOn) {
          issues.push(issue("calibration.issue_date_in_future", path + ".issued_at", "verification_required"));
        }
      }
    });
  }
  if (payload.evidence !== undefined && !Array.isArray(payload.evidence)) errors.push(issue("evidence.invalid_type", "evidence", "verification_required"));
  if (Array.isArray(payload.evidence)) payload.evidence.forEach((entry, i) => {
    unknownKeys(entry, EVIDENCE_KEYS, "evidence[" + i + "]", issues);
    if (!plainObject(entry) || typeof entry.source_class !== "string" ||
        typeof entry.reference !== "string" || !entry.reference.trim()) {
      errors.push(issue("evidence.record_invalid", "evidence[" + i + "]", "verification_required"));
    }
  });
  // Resolve declared relationships without treating declarations as verified evidence.
  const inventoryIds = new Set();
  const inventoryByKind = { equipment: new Set(), sensors: new Set(), gateways: new Set() };
  for (const kind of ["equipment", "sensors", "gateways"]) {
    const records = plainObject(payload.inventory) && Array.isArray(payload.inventory[kind])
      ? payload.inventory[kind] : [];
    for (const record of records) if (plainObject(record) && typeof record.id === "string" && TOKEN.test(record.id)) {
      if (inventoryIds.has(record.id)) {
        errors.push(issue("inventory.id_duplicate_across_types", "inventory." + kind, "verification_required"));
      }
      inventoryIds.add(record.id);
      inventoryByKind[kind].add(record.id);
    }
  }
  if (Array.isArray(payload.site?.irrigation_systems)) {
    payload.site.irrigation_systems.forEach((system, i) => {
      if (plainObject(system) && system.controller_id &&
          !inventoryByKind.equipment.has(system.controller_id)) {
        issues.push(issue("irrigation.controller_reference_unresolved",
          "site.irrigation_systems[" + i + "].controller_id", "verification_required"));
      }
    });
  }
  if (Array.isArray(payload.site?.irrigation_systems)) {
    payload.site.irrigation_systems.forEach((system, i) => {
      if (!plainObject(system)) return;
      const systemPath = "site.irrigation_systems[" + i + "]";
      for (const [field, role] of [["controller_id", "controller"], ["pump_id", "pump"]]) {
        if (system[field] && !inventoryByKind.equipment.has(system[field])) {
          issues.push(issue("irrigation.equipment_reference_unresolved", systemPath + "." + field, "verification_required"));
          continue;
        }
        if (system[field]) {
          const equipment = Array.isArray(payload.inventory?.equipment)
            ? payload.inventory.equipment.find(item => plainObject(item) && item.id === system[field]) : undefined;
          if (equipment?.asset_class && equipment.asset_class !== role) {
            issues.push(issue("irrigation.equipment_role_mismatch", systemPath + "." + field, "verification_required"));
          }
          if (field === "controller_id" && equipment?.protocol && system.control_protocol &&
              equipment.protocol !== "unknown" && system.control_protocol !== "unknown" &&
              equipment.protocol !== system.control_protocol) {
            issues.push(issue("irrigation.controller_protocol_mismatch", systemPath + ".control_protocol", "verification_required"));
          }
          if (field === "pump_id" && equipment && finitePositive(system.design_flow_m3_per_hour) &&
              finitePositive(equipment.rated_flow_m3_per_hour) &&
              system.design_flow_m3_per_hour > equipment.rated_flow_m3_per_hour) {
            issues.push(issue("irrigation.pump_flow_rating_exceeded", systemPath + ".design_flow_m3_per_hour", "verification_required"));
          }
        }
      }
      if (Array.isArray(system.zones)) system.zones.forEach((zone, zoneIndex) => {
        if (!plainObject(zone)) return;
        const zonePath = systemPath + ".zones[" + zoneIndex + "]";
        for (const [field, systemField, role] of [["pump_id", "pump_id", "pump"], ["controller_id", "controller_id", "controller"]]) {
          const reference = zone[field] ?? system[systemField];
          if (reference && !inventoryByKind.equipment.has(reference)) {
            issues.push(issue("irrigation.zone_equipment_reference_unresolved", zonePath + "." + field, "verification_required"));
          } else if (reference) {
            const equipment = Array.isArray(payload.inventory?.equipment)
              ? payload.inventory.equipment.find(item => plainObject(item) && item.id === reference) : undefined;
            if (equipment?.asset_class && equipment.asset_class !== role) {
              issues.push(issue("irrigation.zone_equipment_role_mismatch", zonePath + "." + field, "verification_required"));
            }
          }
        }
        if (finitePositive(zone.design_flow_m3_per_hour) && finitePositive(system.design_flow_m3_per_hour) &&
            zone.design_flow_m3_per_hour > system.design_flow_m3_per_hour) {
          issues.push(issue("irrigation.zone_flow_exceeds_system", zonePath + ".design_flow_m3_per_hour", "verification_required"));
        }
      });
    });
  }
  if (Array.isArray(payload.site?.energy_systems)) {
    payload.site.energy_systems.forEach((system, i) => {
      if (!plainObject(system)) return;
      const equipmentById = id => Array.isArray(payload.inventory?.equipment)
        ? payload.inventory.equipment.find(item => plainObject(item) && item.id === id) : undefined;
      if (Array.isArray(system.pv_strings)) system.pv_strings.forEach((pvString, j) => {
        if (!plainObject(pvString)) return;
        const path = "site.energy_systems[" + i + "].pv_strings[" + j + "]";
        const moduleId = pvString.module_equipment_id ?? system.pv_equipment_id;
        const inverterId = pvString.inverter_id ?? system.inverter_id;
        const module = moduleId ? equipmentById(moduleId) : undefined;
        const inverter = inverterId ? equipmentById(inverterId) : undefined;
        if (!moduleId || !inventoryByKind.equipment.has(moduleId)) {
          issues.push(issue("energy.pv_module_reference_unresolved", path + ".module_equipment_id", "verification_required"));
        }
        if (!inverterId || !inventoryByKind.equipment.has(inverterId)) {
          issues.push(issue("energy.pv_inverter_reference_unresolved", path + ".inverter_id", "verification_required"));
        }
        if (module?.asset_class && module.asset_class !== "pv_module") {
          issues.push(issue("energy.pv_module_role_mismatch", path + ".module_equipment_id", "verification_required"));
        }
        if (inverter?.asset_class && inverter.asset_class !== "inverter") {
          issues.push(issue("energy.pv_inverter_role_mismatch", path + ".inverter_id", "verification_required"));
        }
        if (!module || !inverter || !Number.isInteger(pvString.modules_per_string) ||
            !Number.isInteger(pvString.parallel_strings) || !finitePositive(module.pv_voc_v) ||
            !finitePositive(module.pv_vmp_v)) return;
        const count = pvString.modules_per_string;
        const parallels = pvString.parallel_strings;
        const minTemp = system.design_min_temperature_c;
        const maxTemp = system.design_max_temperature_c;
        if (minTemp !== undefined && finitePositive(module.pv_voc_v) &&
            typeof module.voc_temp_coefficient_pct_per_c === "number" &&
            finitePositive(inverter.inverter_max_input_voltage_v)) {
          const coldVoc = count * module.pv_voc_v *
            (1 + module.voc_temp_coefficient_pct_per_c / 100 * (minTemp - 25));
          if (coldVoc > inverter.inverter_max_input_voltage_v) {
            issues.push(issue("energy.pv_string_cold_voc_exceeds_inverter", path, "verification_required"));
          }
        }
        if (maxTemp !== undefined && typeof module.vmp_temp_coefficient_pct_per_c === "number") {
          const hotVmp = count * module.pv_vmp_v *
            (1 + module.vmp_temp_coefficient_pct_per_c / 100 * (maxTemp - 25));
          if (finitePositive(inverter.inverter_mppt_min_voltage_v) && hotVmp < inverter.inverter_mppt_min_voltage_v) {
            issues.push(issue("energy.pv_string_hot_vmp_below_mppt_min", path, "verification_required"));
          }
          if (finitePositive(inverter.inverter_mppt_max_voltage_v) && hotVmp > inverter.inverter_mppt_max_voltage_v) {
            issues.push(issue("energy.pv_string_hot_vmp_above_mppt_max", path, "verification_required"));
          }
        }
        if (finitePositive(module.pv_imp_a) && finitePositive(inverter.inverter_max_input_current_a) &&
            module.pv_imp_a * parallels > inverter.inverter_max_input_current_a) {
          issues.push(issue("energy.pv_string_operating_current_exceeds_inverter", path, "verification_required"));
        }
        if (finitePositive(module.pv_isc_a) && finitePositive(inverter.inverter_max_short_circuit_current_a) &&
            module.pv_isc_a * parallels > inverter.inverter_max_short_circuit_current_a) {
          issues.push(issue("energy.pv_string_short_circuit_current_exceeds_inverter", path, "verification_required"));
        }
      });
      const battery = system.battery_id && equipmentById(system.battery_id);
      const inverter = system.inverter_id && equipmentById(system.inverter_id);
      if (system.battery_id && battery && system.nominal_voltage_v !== undefined) {
        const low = battery.battery_min_voltage_v;
        const high = battery.battery_max_voltage_v;
        if (finitePositive(low) && finitePositive(high) &&
            (system.nominal_voltage_v < low || system.nominal_voltage_v > high)) {
          issues.push(issue("energy.battery_nominal_voltage_outside_battery_window",
            "site.energy_systems[" + i + "].nominal_voltage_v", "verification_required"));
        }
        if (finitePositive(inverter?.battery_min_voltage_v) && finitePositive(inverter?.battery_max_voltage_v) &&
            (system.nominal_voltage_v < inverter.battery_min_voltage_v || system.nominal_voltage_v > inverter.battery_max_voltage_v)) {
          issues.push(issue("energy.battery_nominal_voltage_outside_inverter_window",
            "site.energy_systems[" + i + "].nominal_voltage_v", "verification_required"));
        }
      }
      for (const [systemField, batteryField, inverterField, code] of [
        ["battery_charge_power_kw", "battery_max_charge_power_kw", "inverter_max_battery_charge_power_kw", "charge"],
        ["battery_discharge_power_kw", "battery_max_discharge_power_kw", "inverter_max_battery_discharge_power_kw", "discharge"],
      ]) {
        const requested = system[systemField];
        if (requested === undefined) continue;
        if (!finitePositive(requested)) continue;
        if (finitePositive(battery?.[batteryField]) && requested > battery[batteryField]) {
          issues.push(issue("energy.battery_" + code + "_power_exceeds_battery_rating",
            "site.energy_systems[" + i + "]." + systemField, "verification_required"));
        }
        if (finitePositive(inverter?.[inverterField]) && requested > inverter[inverterField]) {
          issues.push(issue("energy.battery_" + code + "_power_exceeds_inverter_rating",
            "site.energy_systems[" + i + "]." + systemField, "verification_required"));
        }
      }
      if (finitePositive(system.battery_power_kw) && finitePositive(battery?.rated_power_kw) &&
          system.battery_power_kw > battery.rated_power_kw) {
        issues.push(issue("energy.battery_power_exceeds_equipment_rating",
          "site.energy_systems[" + i + "].battery_power_kw", "verification_required"));
      }
      // Cross-check declared system capacities against referenced nameplate data.
      const systemPath = "site.energy_systems[" + i + "]";
      if (system.inverter_capacity_kw !== undefined && finitePositive(inverter?.rated_power_kw)) {
        const tolerance = Math.max(0.01, system.inverter_capacity_kw * 0.01);
        if (Math.abs(system.inverter_capacity_kw - inverter.rated_power_kw) > tolerance) {
          issues.push(issue("energy.inverter_capacity_mismatch",
            systemPath + ".inverter_capacity_kw", "verification_required"));
        }
      }
      if (system.battery_capacity_kwh !== undefined && finitePositive(battery?.battery_capacity_kwh)) {
        const tolerance = Math.max(0.01, system.battery_capacity_kwh * 0.01);
        if (Math.abs(system.battery_capacity_kwh - battery.battery_capacity_kwh) > tolerance) {
          issues.push(issue("energy.battery_capacity_mismatch",
            systemPath + ".battery_capacity_kwh", "verification_required"));
        }
      }
      if (system.grid_connected === true && finitePositive(system.grid_export_limit_kw) &&
          finitePositive(inverter?.rated_power_kw) &&
          system.grid_export_limit_kw > inverter.rated_power_kw) {
        issues.push(issue("energy.grid_export_limit_exceeds_inverter_rating",
          systemPath + ".grid_export_limit_kw", "verification_required"));
      }
      if (Array.isArray(system.pv_strings) && system.pv_strings.length > 0 &&
          finitePositive(system.pv_capacity_kw)) {
        let derivedPvKw = 0;
        let completePvCapacity = true;
        for (const pvString of system.pv_strings) {
          if (!plainObject(pvString)) { completePvCapacity = false; break; }
          const moduleId = pvString.module_equipment_id ?? system.pv_equipment_id;
          const module = moduleId ? equipmentById(moduleId) : undefined;
          if (!finitePositive(module?.pv_power_w) ||
              !Number.isInteger(pvString.modules_per_string) || pvString.modules_per_string <= 0 ||
              !Number.isInteger(pvString.parallel_strings) || pvString.parallel_strings <= 0) {
            completePvCapacity = false;
            break;
          }
          derivedPvKw += module.pv_power_w * pvString.modules_per_string *
            pvString.parallel_strings / 1000;
        }
        if (completePvCapacity) {
          const tolerance = Math.max(0.01, system.pv_capacity_kw * 0.01);
          if (Math.abs(system.pv_capacity_kw - derivedPvKw) > tolerance) {
            issues.push(issue("energy.pv_capacity_mismatch", systemPath + ".pv_capacity_kw", "verification_required"));
          }
        } else {
          issues.push(issue("energy.pv_capacity_comparison_incomplete",
            systemPath + ".pv_capacity_kw", "verification_required"));
        }
      }
      for (const [field, role] of [["inverter_id", "inverter"], ["battery_id", "battery"], ["pv_equipment_id", "pv"]]) {
        if (system[field] && !inventoryByKind.equipment.has(system[field])) {
          issues.push(issue("energy.equipment_reference_unresolved",
            "site.energy_systems[" + i + "]." + field, "verification_required"));
        } else if (system[field]) {
          const equipment = Array.isArray(payload.inventory?.equipment)
            ? payload.inventory.equipment.find(item => plainObject(item) && item.id === system[field]) : undefined;
          if (equipment && equipment.asset_class &&
              !(role === "pv" ? ["pv", "pv_module", "pv_array"].includes(equipment.asset_class) : equipment.asset_class === role)) {
            issues.push(issue("energy.equipment_role_mismatch",
              "site.energy_systems[" + i + "]." + field, "verification_required"));
          }
          if (role === "inverter" && equipment && finitePositive(system.nominal_voltage_v) &&
              finitePositive(equipment.rated_voltage_v) && system.nominal_voltage_v !== equipment.rated_voltage_v) {
            issues.push(issue("energy.inverter_voltage_mismatch",
              "site.energy_systems[" + i + "].nominal_voltage_v", "verification_required"));
          }
          if (role === "inverter" && equipment && system.grid_phase && equipment.phase &&
              system.grid_phase !== "unknown" && equipment.phase !== "unknown" &&
              system.grid_phase !== equipment.phase) {
            issues.push(issue("energy.inverter_phase_mismatch",
              "site.energy_systems[" + i + "].grid_phase", "verification_required"));
          }
        }
      }
    });
  }
  if (Array.isArray(payload.inventory?.sensors)) {
    payload.inventory.sensors.forEach((sensor, i) => {
      if (!plainObject(sensor) || !sensor.gateway_id) return;
      if (!inventoryByKind.gateways.has(sensor.gateway_id)) {
        issues.push(issue("sensor.gateway_reference_unresolved",
          "inventory.sensors[" + i + "].gateway_id", "verification_required"));
        return;
      }
      const gateway = payload.inventory.gateways.find(item => plainObject(item) && item.id === sensor.gateway_id);
      if (Array.isArray(gateway?.supported_protocols) &&
          typeof sensor.protocol === "string" && PROTOCOLS.has(sensor.protocol) &&
          sensor.protocol !== "unknown" && !gateway.supported_protocols.includes(sensor.protocol)) {
        issues.push(issue("sensor.gateway_protocol_not_declared",
          "inventory.sensors[" + i + "].protocol", "verification_required"));
      } else if (gateway && gateway.supported_protocols === undefined) {
        issues.push(issue("gateway.protocol_capabilities_unspecified",
          "inventory.gateways[" + payload.inventory.gateways.indexOf(gateway) + "].supported_protocols", "verification_required"));
      }
    });
  }
  const calibrationIds = new Set();
  if (Array.isArray(payload.calibration_records)) {
    for (const [i, record] of payload.calibration_records.entries()) {
      if (plainObject(record) && typeof record.id === "string" && TOKEN.test(record.id)) {
        if (calibrationIds.has(record.id)) errors.push(issue("calibration.id_duplicate", "calibration_records[" + i + "].id", "verification_required"));
        calibrationIds.add(record.id);
      }
      if (plainObject(record) && record.scope === "site" && record.scope_id !== payload.site?.site_id) {
        issues.push(issue("calibration.scope_reference_unresolved", "calibration_records[" + i + "].scope_id", "verification_required"));
      }
      if (plainObject(record) && record.scope === "asset" && !inventoryByKind.equipment.has(record.scope_id)) {
        issues.push(issue("calibration.scope_reference_unresolved", "calibration_records[" + i + "].scope_id", "verification_required"));
      }
      if (plainObject(record) && record.scope === "sensor" && !inventoryByKind.sensors.has(record.scope_id)) {
        issues.push(issue("calibration.scope_reference_unresolved", "calibration_records[" + i + "].scope_id", "verification_required"));
      }
    }
  }
  if (plainObject(payload.inventory) && Array.isArray(payload.inventory.sensors)) {
    payload.inventory.sensors.forEach((sensor, i) => {
      if (plainObject(sensor) && sensor.calibration_record_id &&
          !calibrationIds.has(sensor.calibration_record_id)) {
        issues.push(issue("sensor.calibration_reference_unresolved", "inventory.sensors[" + i + "].calibration_record_id", "verification_required"));
      }
    });
  }
  const evidenceReferences = new Set(Array.isArray(payload.evidence)
    ? payload.evidence.filter(plainObject).map(entry => entry.reference) : []);
  const checkEvidenceReference = (reference, path) => {
    if (reference && !evidenceReferences.has(reference)) {
      issues.push(issue("evidence.reference_unresolved", path, "verification_required"));
    }
  };
  if (Array.isArray(payload.calibration_records)) payload.calibration_records.forEach((record, i) => {
    if (plainObject(record)) checkEvidenceReference(record.evidence_ref, "calibration_records[" + i + "].evidence_ref");
  });
  if (Array.isArray(payload.calibration_records)) payload.calibration_records.forEach((record, i) => {
    if (!plainObject(record) || !record.evidence_ref) return;
    const certificateEvidence = Array.isArray(payload.evidence)
      ? payload.evidence.find(entry => plainObject(entry) && entry.reference === record.evidence_ref)
      : undefined;
    if (certificateEvidence && certificateEvidence.source_class !== "calibration_certificate") {
      issues.push(issue("calibration.evidence_source_class_mismatch",
        "calibration_records[" + i + "].evidence_ref", "verification_required"));
    }
    if (certificateEvidence && record.issuer && certificateEvidence.issuer &&
        record.issuer !== certificateEvidence.issuer) {
      issues.push(issue("calibration.issuer_evidence_mismatch",
        "calibration_records[" + i + "].issuer", "verification_required"));
    }
  });
  for (const [kind, records] of [
    ["crops", payload.site?.crops],
    ["soil_profiles", payload.site?.soil_profiles],
    ["irrigation_systems", payload.site?.irrigation_systems],
    ["energy_systems", payload.site?.energy_systems],
    ["water_sources", payload.site?.water_sources],
    ["equipment", payload.inventory?.equipment],
    ["sensors", payload.inventory?.sensors],
    ["gateways", payload.inventory?.gateways],
  ]) {
    if (Array.isArray(records)) records.forEach((record, i) => {
      if (plainObject(record)) {
        checkEvidenceReference(record.evidence_ref, "configuration." + kind + "[" + i + "].evidence_ref");
        if (kind === "crops" && Array.isArray(record.root_depth_observations)) record.root_depth_observations.forEach((observation, j) => {
          if (plainObject(observation)) checkEvidenceReference(observation.evidence_ref, "configuration.crops[" + i + "].root_depth_observations[" + j + "].evidence_ref");
        });
        if (kind === "water_sources" && Array.isArray(record.quality_samples)) record.quality_samples.forEach((sample, j) => {
          if (plainObject(sample)) checkEvidenceReference(sample.evidence_ref, "configuration.water_sources[" + i + "].quality_samples[" + j + "].evidence_ref");
        });
        if (kind === "soil_profiles" && Array.isArray(record.hydraulic_measurements)) record.hydraulic_measurements.forEach((measurement, j) => {
          if (plainObject(measurement)) checkEvidenceReference(measurement.evidence_ref, "configuration.soil_profiles[" + i + "].hydraulic_measurements[" + j + "].evidence_ref");
        });
        if (kind === "soil_profiles" && Array.isArray(record.horizons)) record.horizons.forEach((horizon, j) => {
          if (plainObject(horizon)) checkEvidenceReference(horizon.evidence_ref, "configuration.soil_profiles[" + i + "].horizons[" + j + "].evidence_ref");
        });
        if (kind === "soil_profiles" && Array.isArray(record.samples)) record.samples.forEach((sample, j) => {
          if (plainObject(sample)) checkEvidenceReference(sample.evidence_ref, "configuration.soil_profiles[" + i + "].samples[" + j + "].evidence_ref");
          if (plainObject(sample) && Array.isArray(sample.analytes)) sample.analytes.forEach((analyte, k) => {
            if (plainObject(analyte)) checkEvidenceReference(analyte.evidence_ref, "configuration.soil_profiles[" + i + "].samples[" + j + "].analytes[" + k + "].evidence_ref");
          });
        });
      }
    });
  }
  if (payload.extensions !== undefined) {
    if (!plainObject(payload.extensions)) errors.push(issue("extensions.invalid_type", "extensions", "verification_required"));
    else for (const [namespace, value] of Object.entries(payload.extensions)) {
      if (!/^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31})+$/.test(namespace) || !plainObject(value)) {
        errors.push(issue("extensions.namespace_invalid", "extensions." + namespace, "verification_required"));
      } else issues.push(issue("extensions.requires_client_schema_review", "extensions." + namespace, "verification_required"));
    }
  }
  const invalid = errors.length > 0;
  const verification = issues.some(item => item.severity === "verification_required");
  return Object.freeze({
    valid: !invalid,
    errors: Object.freeze(errors),
    issues: Object.freeze(issues),
    status: Object.freeze({
      structural_validity: invalid ? "invalid" : "valid",
      evidence_readiness: invalid ? "blocked" : verification ? "needs_verification" : issues.length ? "incomplete" : "ready_for_review",
      operational_review: "not_started",
      model_applicability: "not_assessed",
    }),
  });
}
