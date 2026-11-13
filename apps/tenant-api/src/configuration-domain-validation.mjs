const ROOT_KEYS = new Set(["tenant", "site", "inventory", "calibration_records", "evidence", "extensions"]);
const SITE_KEYS = new Set(["site_id", "timezone", "land_area", "boundary", "crops", "irrigation_systems", "energy_systems", "metadata"]);
const INVENTORY_KEYS = new Set(["equipment", "sensors", "gateways"]);
const RECORD_KEYS = {
  crops: new Set(["id", "species", "cultivar", "growth_stage", "planting_date", "expected_harvest_date", "evidence_ref"]),
  irrigation_systems: new Set(["id", "method", "water_source", "design_flow_m3_per_hour", "controller_id", "zones", "evidence_ref"]),
  energy_systems: new Set(["id", "type", "pv_capacity_kw", "inverter_capacity_kw", "battery_capacity_kwh", "battery_power_kw", "nominal_voltage_v", "grid_phase", "grid_connected", "evidence_ref"]),
  equipment: new Set(["id", "manufacturer", "model", "protocol", "asset_class", "serial_number", "ratings", "evidence_ref"]),
  sensors: new Set(["id", "manufacturer", "model", "protocol", "measurements", "connectivity_status", "calibration_record_id", "evidence_ref"]),
  gateways: new Set(["id", "manufacturer", "model", "protocol", "connectivity_status", "evidence_ref"]),
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
  if (!rings.length || rings.some(ring => !Array.isArray(ring) || ring.length < 4 ||
      ring.some(point => !Array.isArray(point) || point.length < 2 ||
        !point.slice(0, 2).every(n => typeof n === "number" && Number.isFinite(n))) ||
      JSON.stringify(ring[0]) !== JSON.stringify(ring[ring.length - 1]))) {
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
export function assessDomainConfiguration(payload) {
  const errors = [];
  const issues = [];
  if (!plainObject(payload)) {
    return Object.freeze({ valid: false, errors: [issue("configuration.root_invalid", "$", "verification_required")],
      issues: [], status: Object.freeze({ structural_validity: "invalid", evidence_readiness: "not_assessed",
        operational_review: "not_started", model_applicability: "not_assessed" }) });
  }
  unknownKeys(payload, ROOT_KEYS, "$", issues);
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
    const crops = payload.site.crops ?? [];
    validateUniqueRecords(crops, "site.crops", errors);
    crops.forEach((crop, i) => {
      if (!plainObject(crop) || typeof crop.species !== "string" || !crop.species.trim()) {
        errors.push(issue("crop.species_required", "site.crops[" + i + "].species", "verification_required"));
      }
      if (crop?.planting_date && !validDate(crop.planting_date)) errors.push(issue("crop.planting_date_invalid", "site.crops[" + i + "].planting_date", "verification_required"));
      if (crop?.expected_harvest_date && !validDate(crop.expected_harvest_date)) errors.push(issue("crop.harvest_date_invalid", "site.crops[" + i + "].expected_harvest_date", "verification_required"));
      if (crop?.planting_date && crop?.expected_harvest_date && validDate(crop.planting_date) && validDate(crop.expected_harvest_date) &&
          crop.expected_harvest_date < crop.planting_date) errors.push(issue("crop.date_order_invalid", "site.crops[" + i + "]", "verification_required"));
    });
    if (!crops.length) issues.push(issue("site.crops_missing", "site.crops"));
    for (const field of ["irrigation_systems", "energy_systems"]) {
      const list = payload.site[field] ?? [];
      validateUniqueRecords(list, "site." + field, errors);
      if (!list.length) issues.push(issue("site." + field + "_missing", "site." + field));
    }
  }
  if (payload.inventory !== undefined) {
    if (!plainObject(payload.inventory)) errors.push(issue("inventory.invalid_type", "inventory", "verification_required"));
    else {
      unknownKeys(payload.inventory, INVENTORY_KEYS, "inventory", issues);
      for (const kind of ["equipment", "sensors", "gateways"]) {
        const records = payload.inventory[kind] ?? [];
        validateUniqueRecords(records, "inventory." + kind, errors);
        records.forEach((record, i) => {
          if (!plainObject(record)) errors.push(issue("inventory.record_invalid", "inventory." + kind + "[" + i + "]", "verification_required"));
          else {
            if (record.protocol !== undefined && !PROTOCOLS.has(record.protocol)) issues.push(issue("inventory.protocol_unrecognized", "inventory." + kind + "[" + i + "].protocol", "verification_required"));
            if (record.protocol === undefined || record.protocol === "unknown") issues.push(issue("inventory.protocol_unknown", "inventory." + kind + "[" + i + "].protocol"));
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
      if (!plainObject(record) || !["site", "asset", "sensor"].includes(record.scope) ||
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
      if (!record?.evidence_ref) issues.push(issue("calibration.evidence_missing", path + ".evidence_ref"));
    });
  }
  if (payload.evidence !== undefined && !Array.isArray(payload.evidence)) errors.push(issue("evidence.invalid_type", "evidence", "verification_required"));
  if (Array.isArray(payload.evidence)) payload.evidence.forEach((entry, i) => {
    if (!plainObject(entry) || typeof entry.source_class !== "string" ||
        typeof entry.reference !== "string" || !entry.reference.trim()) {
      errors.push(issue("evidence.record_invalid", "evidence[" + i + "]", "verification_required"));
    }
  });
  if (payload.extensions !== undefined) {
    if (!plainObject(payload.extensions)) errors.push(issue("extensions.invalid_type", "extensions", "verification_required"));
    else for (const [namespace, value] of Object.entries(payload.extensions)) {
      if (!/^[a-z][a-z0-9.-]{1,63}$/.test(namespace) || !plainObject(value)) {
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
