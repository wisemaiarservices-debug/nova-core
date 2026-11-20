import test from "node:test";
import assert from "node:assert/strict";
import { validateSourceCapabilityDraft } from "../src/source-capability-contract.mjs";

const source = {
  id: "source-a",
  tenant_id: "tenant-a",
  site_id: "site-a",
  module: "neoagro",
  verification_status: "verified",
};

const draft = {
  source_id: "source-a",
  tenant_id: "tenant-a",
  site_id: "site-a",
  module: "neoagro",
  metric: "soil.moisture.vwc",
  unit: "m3/m3",
  measurement_kind: "measured",
  quantity_semantics: "Volumetric water content as a ratio of water volume to bulk soil volume",
  acquisition_protocol: "modbus_tcp_v1",
  sampling: { mode: "interval", interval_seconds: 300, max_age_seconds: 900 },
  timestamp: { max_future_skew_seconds: 60, timezone: "UTC" },
  quality: { allowed_flags: ["sensor_warmup", "estimated_clock"] },
  calibration: { required: true, profile_ref: "calibration/profile-2026-01" },
  data_rights_ref: "rights/tenant-a/provider-contract-1",
  evidence_ref: "evidence/source-a-capability-1",
  version: 1,
};

test("accepts a structurally complete capability bound to its verified source", () => {
  assert.deepEqual(validateSourceCapabilityDraft(draft, source), { valid: true, errors: [] });
});

test("rejects unverified, disabled or malformed source context", () => {
  for (const verification_status of ["unverified", "disabled", "rejected", undefined]) {
    const result = validateSourceCapabilityDraft(draft, { ...source, verification_status });
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, "source.not_verified_or_invalid");
  }
});

test("rejects tenant, site, source and module mismatches", () => {
  const cases = [
    [{ ...draft, source_id: "source-b" }, "capability.source_mismatch"],
    [{ ...draft, tenant_id: "tenant-b" }, "capability.tenant_mismatch"],
    [{ ...draft, site_id: "site-b" }, "capability.site_mismatch"],
    [{ ...draft, module: "neogrid" }, "capability.module_mismatch"],
  ];
  for (const [candidate, expected] of cases) {
    const result = validateSourceCapabilityDraft(candidate, source);
    assert.ok(result.errors.some(error => error.code === expected));
  }
});

test("rejects unknown fields rather than silently accepting policy extensions", () => {
  const result = validateSourceCapabilityDraft({ ...draft, endpoint_url: "https://example.invalid" }, source);
  assert.deepEqual(result.errors, [{ code: "capability.invalid_shape", path: "$" }]);
});

test("requires canonical metric and explicit unit semantics", () => {
  for (const metric of ["Soil.Moisture", "soil moisture", "soil/*", ""]) {
    assert.equal(validateSourceCapabilityDraft({ ...draft, metric }, source).valid, false);
  }
  for (const unit of ["", "m3 / m3", " "]) {
    assert.equal(validateSourceCapabilityDraft({ ...draft, unit }, source).valid, false);
  }
});

test("rejects unbounded, fractional and malformed sampling policy", () => {
  const candidates = [
    { ...draft.sampling, interval_seconds: 0 },
    { ...draft.sampling, interval_seconds: 1.5 },
    { ...draft.sampling, max_age_seconds: 0 },
    { ...draft.sampling, mode: "poll-whenever" },
  ];
  for (const sampling of candidates) {
    assert.equal(validateSourceCapabilityDraft({ ...draft, sampling }, source).valid, false);
  }
});

test("event sampling cannot smuggle an interval value", () => {
  const validEvent = { ...draft, sampling: { mode: "event", max_age_seconds: 3600 } };
  assert.equal(validateSourceCapabilityDraft(validEvent, source).valid, true);
  const invalidEvent = { ...draft, sampling: { mode: "event", interval_seconds: 60, max_age_seconds: 3600 } };
  assert.equal(validateSourceCapabilityDraft(invalidEvent, source).valid, false);
});

test("requires explicit timezone and bounded future clock skew", () => {
  assert.equal(validateSourceCapabilityDraft({ ...draft, timestamp: { timezone: "UTC", max_future_skew_seconds: 0 } }, source).valid, true);
  for (const timestamp of [
    { timezone: "local", max_future_skew_seconds: 10 },
    { timezone: "UTC", max_future_skew_seconds: -1 },
    { timezone: "UTC", max_future_skew_seconds: 86401 },
  ]) {
    assert.equal(validateSourceCapabilityDraft({ ...draft, timestamp }, source).valid, false);
  }
});

test("requires unique bounded quality flags and a calibration reference when required", () => {
  assert.equal(validateSourceCapabilityDraft({ ...draft, quality: { allowed_flags: ["offline"] } }, source).valid, true);
  assert.equal(validateSourceCapabilityDraft({ ...draft, quality: { allowed_flags: ["offline", "offline"] } }, source).valid, false);
  assert.equal(validateSourceCapabilityDraft({ ...draft, calibration: { required: true } }, source).valid, false);
  assert.equal(validateSourceCapabilityDraft({ ...draft, calibration: { required: false } }, source).valid, true);
});

test("requires evidence and data-rights references", () => {
  assert.equal(validateSourceCapabilityDraft({ ...draft, evidence_ref: "" }, source).valid, false);
  assert.equal(validateSourceCapabilityDraft({ ...draft, data_rights_ref: "" }, source).valid, false);
});

test("does not treat a valid draft as approval or persistence authority", () => {
  const result = validateSourceCapabilityDraft(draft, source);
  assert.equal(result.valid, true);
  assert.equal(Object.hasOwn(result, "status"), false);
  assert.equal(Object.hasOwn(result, "approved"), false);
});
