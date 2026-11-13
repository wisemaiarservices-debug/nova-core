import test from "node:test";
import assert from "node:assert/strict";
import { assessDomainConfiguration } from "../src/configuration-domain-validation.mjs";

const valid = () => ({
  tenant: { tenant_id: "tenant-a" },
  site: {
    site_id: "site-a", timezone: "Africa/Tunis",
    land_area: { value: 2.5, unit: "ha" },
    boundary: { type: "Polygon", crs: "EPSG:4326", coordinates: [[[10,36],[11,36],[11,37],[10,36]]] },
    crops: [{ id: "crop-1", species: "olive", planting_date: "2026-01-01" }],
    irrigation_systems: [{ id: "irrigation-1", method: "drip" }, { id: "irrigation-2", method: "rainfed" }],
    energy_systems: [{ id: "energy-1", type: "solar" }, { id: "energy-2", type: "grid" }],
  },
  inventory: {
    equipment: [{ id: "pump-1", manufacturer: "Vendor", model: "P1", protocol: "modbus_tcp" }],
    sensors: [{ id: "sensor-1", manufacturer: "Vendor", model: "S1", protocol: "mqtt" }],
    gateways: [{ id: "gateway-1", protocol: "lorawan" }],
  },
  calibration_records: [{
    id: "cal-1", scope: "sensor", scope_id: "sensor-1", unit: "%", method: "two-point",
    effective_from: "2026-01-01", effective_to: "2027-01-01", evidence_ref: "cert-1",
  }],
  evidence: [{ source_class: "manufacturer_document", reference: "datasheet-1" }],
});

test("accepts extensible multi-system configuration without implying operational approval", () => {
  const result = assessDomainConfiguration(valid());
  assert.equal(result.valid, true);
  assert.equal(result.status.structural_validity, "valid");
  assert.equal(result.status.operational_review, "not_started");
  assert.equal(result.status.model_applicability, "not_assessed");
});

test("keeps incomplete specifications explicit rather than inventing values", () => {
  const value = valid();
  delete value.site.land_area;
  delete value.site.boundary;
  value.site.crops = [];
  value.site.irrigation_systems = [];
  value.site.energy_systems = [];
  delete value.inventory;
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, true);
  assert.equal(result.status.evidence_readiness, "needs_verification");
  assert.ok(result.issues.some(item => item.code === "site.land_area_missing"));
  assert.ok(result.issues.some(item => item.code === "inventory.not_supplied"));
});

test("rejects geometry without explicit CRS and valid closed coordinate rings", () => {
  const value = valid();
  delete value.site.boundary.crs;
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(item => item.code === "geometry.crs_or_coordinates_missing"));
});

test("rejects invalid land-area units, duplicate IDs and impossible crop date order", () => {
  const value = valid();
  value.site.land_area.unit = "football_fields";
  value.site.crops[0].expected_harvest_date = "2025-01-01";
  value.site.crops.push({ id: "crop-1", species: "citrus" });
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(item => item.code === "site.land_area_invalid"));
  assert.ok(result.errors.some(item => item.code === "record.id_missing_or_duplicate"));
  assert.ok(result.errors.some(item => item.code === "crop.date_order_invalid"));
});

test("preserves namespaced client extensions but flags them for schema review", () => {
  const value = valid();
  value.extensions = { "client.alpha": { irrigation_zone_codes: ["A", "B"] } };
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, true);
  assert.ok(result.issues.some(item => item.code === "extensions.requires_client_schema_review"));
});

test("flags unnamespaced extensions and unknown root fields rather than silently accepting them", () => {
  const value = valid();
  value.extensions = { custom: { field: true } };
  value.unexpected = true;
  const result = assessDomainConfiguration(value);
  assert.ok(result.errors.some(item => item.code === "extensions.namespace_invalid"));
  assert.ok(result.issues.some(item => item.code === "field.unsupported"));
});

test("calibration requires explicit customer scope, unit, method and effective dates", () => {
  const value = valid();
  value.calibration_records[0].scope = "global_model";
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(item => item.code === "calibration.record_invalid"));
});

test("sensor declarations and missing evidence do not become verified telemetry", () => {
  const value = valid();
  value.inventory.sensors[0].protocol = "unknown";
  value.calibration_records[0].evidence_ref = "";
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, true);
  assert.equal(result.status.evidence_readiness, "needs_verification");
  assert.ok(result.issues.some(item => item.code === "inventory.protocol_unknown"));
  assert.ok(result.issues.some(item => item.code === "calibration.evidence_missing"));
});

test("flags unrecognized protocols and client-specific equipment fields", () => {
  const value = valid();
  value.inventory.equipment[0].protocol = "vendor-proprietary-bus";
  value.inventory.equipment[0].custom_rating = { value: 12 };
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, true);
  assert.ok(result.issues.some(item => item.code === "inventory.protocol_unrecognized"));
  assert.ok(result.issues.some(item => item.code === "field.unsupported"));
});

test("validates positive engineering ratings without assuming a fixed equipment design", () => {
  const value = valid();
  value.site.irrigation_systems[0].design_flow_m3_per_hour = -3;
  value.site.energy_systems[0].battery_capacity_kwh = 0;
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, false);
  assert.equal(result.errors.filter(item => item.code === "engineering.rating_must_be_positive").length, 2);
});

test("allows tenant identity while surfacing unsupported nested crop and equipment fields", () => {
  const value = valid();
  value.site.crops[0].cultivar_code_from_vendor = "X7";
  value.inventory.equipment[0].rated_voltage = 24;
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, true);
  assert.ok(result.issues.some(item => item.path === "site.crops[0].cultivar_code_from_vendor"));
  assert.ok(result.issues.some(item => item.path === "inventory.equipment[0].rated_voltage"));
  assert.equal(result.issues.some(item => item.path === "tenant.tenant_id"), false);
});

test("returns structured errors for malformed collections instead of throwing", () => {
  const value = valid();
  value.site.crops = "olive";
  value.site.irrigation_systems = { id: "bad" };
  value.inventory.sensors = "sensor";
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(item => item.code === "collection.invalid_type" && item.path === "site.crops"));
  assert.ok(result.errors.some(item => item.code === "collection.invalid_type" && item.path === "site.irrigation_systems"));
  assert.ok(result.errors.some(item => item.code === "collection.invalid_type" && item.path === "inventory.sensors"));
});

test("rejects zero-area polygon rings and out-of-range WGS84 coordinates", () => {
  const degenerate = valid();
  degenerate.site.boundary.coordinates = [[[10,36],[11,37],[12,38],[10,36]]];
  const degenerateResult = assessDomainConfiguration(degenerate);
  assert.ok(degenerateResult.errors.some(item => item.code === "geometry.invalid_ring"));

  const outOfRange = valid();
  outOfRange.site.boundary.coordinates = [[[10,36],[11,36],[181,37],[10,36]]];
  const rangeResult = assessDomainConfiguration(outOfRange);
  assert.ok(rangeResult.errors.some(item => item.code === "geometry.invalid_ring"));
});

test("flags unresolved calibration targets, sensor calibration links and evidence references", () => {
  const value = valid();
  value.calibration_records[0].id = "cal-1";
  value.calibration_records[0].scope_id = "sensor-does-not-exist";
  value.inventory.sensors[0].calibration_record_id = "cal-missing";
  value.calibration_records[0].evidence_ref = "evidence-does-not-exist";
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, true);
  assert.ok(result.issues.some(item => item.code === "calibration.scope_reference_unresolved"));
  assert.ok(result.issues.some(item => item.code === "sensor.calibration_reference_unresolved"));
  assert.ok(result.issues.some(item => item.code === "evidence.reference_unresolved"));
});

test("validates irrigation controller and sensor gateway references by resource type", () => {
  const value = valid();
  value.site.irrigation_systems[0].controller_id = "missing-controller";
  value.inventory.sensors[0].gateway_id = "missing-gateway";
  const result = assessDomainConfiguration(value);
  assert.ok(result.issues.some(item => item.code === "irrigation.controller_reference_unresolved"));
  assert.ok(result.issues.some(item => item.code === "sensor.gateway_reference_unresolved"));

  const resolved = valid();
  resolved.site.irrigation_systems[0].controller_id = "pump-1";
  resolved.inventory.sensors[0].gateway_id = "gateway-1";
  const resolvedResult = assessDomainConfiguration(resolved);
  assert.equal(resolvedResult.issues.some(item => item.code === "irrigation.controller_reference_unresolved"), false);
  assert.equal(resolvedResult.issues.some(item => item.code === "sensor.gateway_reference_unresolved"), false);
});

test("checks declared sensor protocol against gateway capabilities without inferring connectivity", () => {
  const compatible = valid();
  compatible.inventory.sensors[0].gateway_id = "gateway-1";
  compatible.inventory.gateways[0].supported_protocols = ["mqtt", "lorawan"];
  const compatibleResult = assessDomainConfiguration(compatible);
  assert.equal(compatibleResult.issues.some(item => item.code === "sensor.gateway_protocol_not_declared"), false);
  assert.equal(compatibleResult.status.operational_review, "not_started");

  const incompatible = valid();
  incompatible.inventory.sensors[0].gateway_id = "gateway-1";
  incompatible.inventory.gateways[0].supported_protocols = ["lorawan"];
  const incompatibleResult = assessDomainConfiguration(incompatible);
  assert.ok(incompatibleResult.issues.some(item => item.code === "sensor.gateway_protocol_not_declared"));

  const unspecified = valid();
  unspecified.inventory.sensors[0].gateway_id = "gateway-1";
  const unspecifiedResult = assessDomainConfiguration(unspecified);
  assert.ok(unspecifiedResult.issues.some(item => item.code === "gateway.protocol_capabilities_unspecified"));
});

test("rejects malformed and duplicate gateway protocol capability declarations", () => {
  const malformed = valid();
  malformed.inventory.gateways[0].supported_protocols = "mqtt";
  const malformedResult = assessDomainConfiguration(malformed);
  assert.ok(malformedResult.errors.some(item => item.code === "gateway.supported_protocols_invalid"));

  const duplicate = valid();
  duplicate.inventory.gateways[0].supported_protocols = ["mqtt", "mqtt"];
  const duplicateResult = assessDomainConfiguration(duplicate);
  assert.ok(duplicateResult.errors.some(item => item.code === "gateway.supported_protocols_duplicate"));
});

test("validates irrigation pump and controller references, roles and declared protocols", () => {
  const value = valid();
  value.site.irrigation_systems[0].controller_id = "controller-1";
  value.site.irrigation_systems[0].pump_id = "pump-1";
  value.site.irrigation_systems[0].control_protocol = "modbus_tcp";
  value.site.irrigation_systems[0].design_flow_m3_per_hour = 8;
  value.inventory.equipment[0].asset_class = "pump";
  value.inventory.equipment[0].rated_flow_m3_per_hour = 6;
  value.inventory.equipment.push({
    id: "controller-1", manufacturer: "Vendor", model: "CTRL-1",
    asset_class: "controller", protocol: "mqtt",
  });
  const result = assessDomainConfiguration(value);
  assert.ok(result.issues.some(item => item.code === "irrigation.controller_protocol_mismatch"));
  assert.ok(result.issues.some(item => item.code === "irrigation.pump_flow_rating_exceeded"));

  const matching = valid();
  matching.site.irrigation_systems[0].controller_id = "controller-1";
  matching.site.irrigation_systems[0].pump_id = "pump-1";
  matching.site.irrigation_systems[0].control_protocol = "modbus_tcp";
  matching.site.irrigation_systems[0].design_flow_m3_per_hour = 5;
  matching.inventory.equipment[0].asset_class = "pump";
  matching.inventory.equipment[0].rated_flow_m3_per_hour = 6;
  matching.inventory.equipment.push({
    id: "controller-1", manufacturer: "Vendor", model: "CTRL-1",
    asset_class: "controller", protocol: "modbus_tcp",
  });
  const matchingResult = assessDomainConfiguration(matching);
  assert.equal(matchingResult.issues.some(item => item.code === "irrigation.controller_protocol_mismatch"), false);
  assert.equal(matchingResult.issues.some(item => item.code === "irrigation.pump_flow_rating_exceeded"), false);
});

test("validates irrigation zone identifiers, equipment links and declared flow limits", () => {
  const value = valid();
  value.site.irrigation_systems[0].pump_id = "pump-1";
  value.site.irrigation_systems[0].design_flow_m3_per_hour = 10;
  value.site.irrigation_systems[0].zones = [
    { id: "zone-a", pump_id: "missing-pump", design_flow_m3_per_hour: 12 },
    { id: "zone-a", area_ha: -1 },
  ];
  const result = assessDomainConfiguration(value);
  assert.ok(result.errors.some(item => item.code === "irrigation.zone_id_missing_or_duplicate"));
  assert.ok(result.errors.some(item => item.code === "engineering.rating_must_be_positive"));
  assert.ok(result.issues.some(item => item.code === "irrigation.zone_equipment_reference_unresolved"));
  assert.ok(result.issues.some(item => item.code === "irrigation.zone_flow_exceeds_system"));
});

test("flags irrigation equipment role mismatches and unresolved controller references", () => {
  const value = valid();
  value.site.irrigation_systems[0].controller_id = "pump-1";
  value.inventory.equipment[0].asset_class = "pump";
  const result = assessDomainConfiguration(value);
  assert.ok(result.issues.some(item => item.code === "irrigation.equipment_role_mismatch"));
});

test("resolves energy equipment references and flags declared voltage or phase mismatches", () => {
  const value = valid();
  value.site.energy_systems[0].inverter_id = "inverter-1";
  value.site.energy_systems[0].nominal_voltage_v = 230;
  value.site.energy_systems[0].grid_phase = "single_phase";
  value.inventory.equipment.push({
    id: "inverter-1", manufacturer: "Vendor", model: "INV-1",
    asset_class: "inverter", rated_voltage_v: 400, phase: "three_phase",
  });
  const result = assessDomainConfiguration(value);
  assert.ok(result.issues.some(item => item.code === "energy.inverter_voltage_mismatch"));
  assert.ok(result.issues.some(item => item.code === "energy.inverter_phase_mismatch"));

  const matching = valid();
  matching.site.energy_systems[0].inverter_id = "inverter-1";
  matching.site.energy_systems[0].nominal_voltage_v = 230;
  matching.site.energy_systems[0].grid_phase = "single_phase";
  matching.inventory.equipment.push({
    id: "inverter-1", manufacturer: "Vendor", model: "INV-1",
    asset_class: "inverter", rated_voltage_v: 230, phase: "single_phase",
  });
  const matchingResult = assessDomainConfiguration(matching);
  assert.equal(matchingResult.issues.some(item => item.code === "energy.inverter_voltage_mismatch"), false);
  assert.equal(matchingResult.issues.some(item => item.code === "energy.inverter_phase_mismatch"), false);
});

test("flags unresolved or role-mismatched energy equipment references", () => {
  const value = valid();
  value.site.energy_systems[0].battery_id = "missing-battery";
  value.site.energy_systems[0].pv_equipment_id = "pump-1";
  value.inventory.equipment[0].asset_class = "pump";
  const result = assessDomainConfiguration(value);
  assert.ok(result.issues.some(item => item.code === "energy.equipment_reference_unresolved"));
  assert.ok(result.issues.some(item => item.code === "energy.equipment_role_mismatch"));
});

test("rejects invalid declared equipment ratings and phase values", () => {
  const value = valid();
  value.inventory.equipment[0].rated_voltage_v = 0;
  value.inventory.equipment[0].phase = "five_phase";
  value.site.energy_systems[0].grid_phase = "unknown_phase";
  const result = assessDomainConfiguration(value);
  assert.ok(result.errors.some(item => item.code === "engineering.rating_must_be_positive"));
  assert.ok(result.errors.some(item => item.code === "equipment.phase_invalid"));
  assert.ok(result.errors.some(item => item.code === "energy.grid_phase_invalid"));
});

test("does not resolve a sensor calibration against an equipment identifier", () => {
  const value = valid();
  value.calibration_records[0].scope = "sensor";
  value.calibration_records[0].scope_id = "pump-1";
  const result = assessDomainConfiguration(value);
  assert.ok(result.issues.some(item => item.code === "calibration.scope_reference_unresolved"));
});

test("rejects identifier collisions across equipment, sensors and gateways", () => {
  const value = valid();
  value.inventory.sensors[0].id = value.inventory.equipment[0].id;
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(item => item.code === "inventory.id_duplicate_across_types"));
});
test("rejects calibration records without stable unique identifiers", () => {
  const missing = valid();
  delete missing.calibration_records[0].id;
  const missingResult = assessDomainConfiguration(missing);
  assert.equal(missingResult.valid, false);
  assert.ok(missingResult.errors.some(item => item.code === "calibration.record_invalid"));

  const duplicate = valid();
  duplicate.calibration_records[0].id = "cal-1";
  duplicate.calibration_records.push({ ...duplicate.calibration_records[0] });
  const duplicateResult = assessDomainConfiguration(duplicate);
  assert.equal(duplicateResult.valid, false);
  assert.ok(duplicateResult.errors.some(item => item.code === "calibration.id_duplicate"));
});
test("tracks calibration certificate identity, issuer, issue date and expiry", () => {
  const value = valid();
  Object.assign(value.calibration_records[0], {
    certificate_number: "CERT-2026-0042",
    issuer: "Accredited Calibration Lab",
    issued_at: "2026-01-01",
  });
  value.evidence[0] = {
    source_class: "calibration_certificate",
    reference: "cert-1",
    issuer: "Accredited Calibration Lab",
    observed_at: "2026-01-01T00:00:00Z",
    digest: "sha256:example",
  };
  const current = assessDomainConfiguration(value, { assessedOn: "2026-06-01" });
  assert.equal(current.issues.some(item => item.code.startsWith("calibration.certificate_") ||
    item.code === "calibration.issuer_missing" || item.code === "calibration.issued_at_missing_or_invalid"), false);
  assert.equal(current.issues.some(item => item.code === "calibration.expired"), false);

  const expired = assessDomainConfiguration(value, { assessedOn: "2028-01-02" });
  assert.ok(expired.issues.some(item => item.code === "calibration.expired"));
  assert.equal(expired.valid, true);
  assert.equal(expired.status.operational_review, "not_started");
});

test("flags incomplete, future-dated and internally inconsistent calibration certificates", () => {
  const missing = valid();
  const missingResult = assessDomainConfiguration(missing, { assessedOn: "2026-06-01" });
  assert.ok(missingResult.issues.some(item => item.code === "calibration.certificate_number_missing"));
  assert.ok(missingResult.issues.some(item => item.code === "calibration.issuer_missing"));
  assert.ok(missingResult.issues.some(item => item.code === "calibration.issued_at_missing_or_invalid"));

  const future = valid();
  Object.assign(future.calibration_records[0], {
    certificate_number: "CERT-FUTURE",
    issuer: "Lab",
    issued_at: "2027-01-01",
    effective_from: "2027-02-01",
  });
  const futureResult = assessDomainConfiguration(future, { assessedOn: "2026-06-01" });
  assert.ok(futureResult.issues.some(item => item.code === "calibration.not_yet_effective"));
  assert.ok(futureResult.issues.some(item => item.code === "calibration.issue_date_in_future"));

  const issuedLate = valid();
  Object.assign(issuedLate.calibration_records[0], {
    certificate_number: "CERT-LATE",
    issuer: "Lab",
    issued_at: "2026-02-01",
    effective_from: "2026-01-01",
  });
  const lateResult = assessDomainConfiguration(issuedLate, { assessedOn: "2026-06-01" });
  assert.ok(lateResult.issues.some(item => item.code === "calibration.certificate_issued_after_effective_date"));
});

test("checks calibration certificate evidence class and issuer consistency", () => {
  const value = valid();
  Object.assign(value.calibration_records[0], {
    certificate_number: "CERT-1",
    issuer: "Lab A",
    issued_at: "2026-01-01",
  });
  value.evidence[0] = {
    source_class: "manufacturer_document",
    reference: "cert-1",
    issuer: "Lab B",
  };
  const result = assessDomainConfiguration(value, { assessedOn: "2026-06-01" });
  assert.ok(result.issues.some(item => item.code === "calibration.evidence_source_class_mismatch"));
  assert.ok(result.issues.some(item => item.code === "calibration.issuer_evidence_mismatch"));
});

test("accepts resolved calibration and evidence links while keeping approval separate", () => {
  const value = valid();
  value.calibration_records[0].id = "cal-1";
  value.calibration_records[0].scope_id = "sensor-1";
  value.calibration_records[0].evidence_ref = "calibration-certificate";
  value.evidence.push({ source_class: "calibration_certificate", reference: "calibration-certificate" });
  value.inventory.sensors[0].calibration_record_id = "cal-1";
  const result = assessDomainConfiguration(value);
  assert.equal(result.valid, true);
  assert.equal(result.status.operational_review, "not_started");
  assert.equal(result.status.model_applicability, "not_assessed");
  assert.equal(result.issues.some(item => item.code === "calibration.scope_reference_unresolved"), false);
  assert.equal(result.issues.some(item => item.code === "sensor.calibration_reference_unresolved"), false);
  assert.equal(result.issues.some(item => item.code === "evidence.reference_unresolved"), false);
});
