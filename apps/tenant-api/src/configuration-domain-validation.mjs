const ROOT_KEYS = new Set(["tenant", "site", "inventory", "calibration_records", "evidence", "extensions"]);
const TENANT_KEYS = new Set(["tenant_id"]);
const SITE_KEYS = new Set(["site_id", "timezone", "land_area", "boundary", "crops", "irrigation_systems", "energy_systems", "metadata"]);
const INVENTORY_KEYS = new Set(["equipment", "sensors", "gateways"]);
const CALIBRATION_KEYS = new Set(["id", "scope", "scope_id", "unit", "method", "effective_from", "effective_to", "certificate_number", "issuer", "issued_at", "evidence_ref"]); 
const EVIDENCE_KEYS = new Set(["id", "source_class", "reference", "observed_at", "issuer", "digest"]);
const RECORD_KEYS = {
  crops: new Set(["id", "species", "cultivar", "growth_stage", "planting_date", "expected_harvest_date", "evidence_ref"]),
  irrigation_systems: new Set(["id", "method", "water_source", "design_flow_m3_per_hour", "controller_id", "pump_id", "control_protocol", "zones", "evidence_ref"]),
  energy_systems: new Set(["id", "type", "pv_capacity_kw", "inverter_capacity_kw", "battery_capacity_kwh", "battery_power_kw", "nominal_voltage_v", "grid_phase", "grid_connected", "inverter_id", "battery_id", "pv_equipment_id", "evidence_ref"]),
  equipment: new Set(["id", "manufacturer", "model", "protocol", "asset_class", "serial_number", "ratings", "rated_voltage_v", "rated_power_kw", "rated_flow_m3_per_hour", "phase", "evidence_ref"]),
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
      const list = validateUniqueRecords(payload.site[field] ?? [], "site." + field, errors);
      list.forEach((record, index) => {
        unknownKeys(record, RECORD_KEYS[field], "site." + field + "[" + index + "]", issues);
        if (!plainObject(record)) return;
        const positiveFields = field === "irrigation_systems"
          ? ["design_flow_m3_per_hour"]
          : ["pv_capacity_kw", "inverter_capacity_kw", "battery_capacity_kwh", "battery_power_kw", "nominal_voltage_v"];
        for (const key of positiveFields) {
          if (record[key] !== undefined && record[key] !== null && !finitePositive(record[key])) {
            errors.push(issue("engineering.rating_must_be_positive", "site." + field + "[" + index + "]." + key, "verification_required"));
          }
        }
        if (field === "energy_systems" && record.grid_phase !== undefined &&
            !["single_phase", "three_phase", "dc", "unknown"].includes(record.grid_phase)) {
          errors.push(issue("energy.grid_phase_invalid", "site.energy_systems[" + index + "].grid_phase", "verification_required"));
        }
        if (field === "irrigation_systems") {
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
                if (!plainObject(zone) || typeof zone.id !== "string" || !TOKEN.test(zone.id) || zoneIds.has(zone.id)) {
                  errors.push(issue("irrigation.zone_id_missing_or_duplicate", zonePath + ".id", "verification_required"));
                  return;
                }
                zoneIds.add(zone.id);
                unknownKeys(zone, new Set(["id", "pump_id", "controller_id", "design_flow_m3_per_hour", "area_ha"]), zonePath, issues);
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
              for (const key of ["rated_voltage_v", "rated_power_kw", "rated_flow_m3_per_hour"]) {
                if (record[key] !== undefined && record[key] !== null && !finitePositive(record[key])) {
                  errors.push(issue("engineering.rating_must_be_positive", "inventory.equipment[" + i + "]." + key, "verification_required"));
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
      for (const [field, role] of [["inverter_id", "inverter"], ["battery_id", "battery"], ["pv_equipment_id", "pv"]]) {
        if (system[field] && !inventoryByKind.equipment.has(system[field])) {
          issues.push(issue("energy.equipment_reference_unresolved",
            "site.energy_systems[" + i + "]." + field, "verification_required"));
        } else if (system[field]) {
          const equipment = Array.isArray(payload.inventory?.equipment)
            ? payload.inventory.equipment.find(item => plainObject(item) && item.id === system[field]) : undefined;
          if (equipment && equipment.asset_class && equipment.asset_class !== role) {
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
    ["irrigation_systems", payload.site?.irrigation_systems],
    ["energy_systems", payload.site?.energy_systems],
    ["equipment", payload.inventory?.equipment],
    ["sensors", payload.inventory?.sensors],
    ["gateways", payload.inventory?.gateways],
  ]) {
    if (Array.isArray(records)) records.forEach((record, i) => {
      if (plainObject(record)) checkEvidenceReference(record.evidence_ref, "configuration." + kind + "[" + i + "].evidence_ref");
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
