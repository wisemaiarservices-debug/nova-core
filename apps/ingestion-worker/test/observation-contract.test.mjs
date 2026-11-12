import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateObservationPayload } from "../src/observation-contract.mjs";

const now = Date.parse("2026-11-10T15:00:00.000Z");
const valid = {
  site_id: "site-001",
  asset_id: "asset-001",
  source_id: "source-weather-01",
  module: "neoagro",
  metric: "air_temperature",
  value: 18.5,
  unit: "degC",
  observed_at: "2026-11-10T14:55:00+00:00",
  idempotency_key: "neoagro:site-001:weather:001",
  provenance: { provider: "Example station", acquisition_method: "sensor", source_record_ref: "record-001" },
  quality_flags: [],
};

const sharedFixture = JSON.parse(
  readFileSync(new URL("./fixtures/nova-core-observation-v1.json", import.meta.url), "utf8"),
);

function applyFixtureCase(payload, fixtureCase) {
  const path = fixtureCase.path ?? fixtureCase.delete;
  let parent = payload;
  for (const key of path.slice(0, -1)) parent = parent[key];
  const key = path[path.length - 1];
  if (fixtureCase.delete) delete parent[key];
  else parent[key] = fixtureCase.value;
  return payload;
}

test("shared v1 fixture accepts every registered module", () => {
  for (const module of sharedFixture.allowed_modules) {
    const payload = structuredClone(sharedFixture.base_payload);
    payload.module = module;
    assert.doesNotThrow(() => validateObservationPayload(payload, Date.parse(sharedFixture.fixed_now)), module);
  }
});

test("shared v1 fixture accepts every positive boundary case", () => {
  for (const fixtureCase of sharedFixture.accepted) {
    const payload = applyFixtureCase(structuredClone(sharedFixture.base_payload), fixtureCase);
    assert.doesNotThrow(
      () => validateObservationPayload(payload, Date.parse(sharedFixture.fixed_now)),
      fixtureCase.id,
    );
  }
});

test("shared v1 fixture rejects every negative boundary case", () => {
  for (const fixtureCase of sharedFixture.rejected) {
    const payload = applyFixtureCase(structuredClone(sharedFixture.base_payload), fixtureCase);
    assert.throws(
      () => validateObservationPayload(payload, Date.parse(sharedFixture.fixed_now)),
      undefined,
      fixtureCase.id,
    );
  }
});

test("accepts a complete scalar observation and normalizes its timestamp", () => {
  const result = validateObservationPayload(valid, now);
  assert.equal(result.observed_at, "2026-11-10T14:55:00.000Z");
  assert.equal(result.value, 18.5);
  assert.deepEqual(result.quality_flags, []);
});

for (const [name, mutate] of [
  ["unknown top-level field", (p) => { p.verified = true; }],
  ["unknown provenance field", (p) => { p.provenance.actor = "caller"; }],
  ["unsupported module", (p) => { p.module = "unknown"; }],
  ["blank site", (p) => { p.site_id = " "; }],
  ["BOM-only site identifier", (p) => { p.site_id = "\ufeff"; }],
  ["UTF-16 overlength site identifier", (p) => { p.site_id = "😀".repeat(61); }],
  ["numeric string value", (p) => { p.value = "18.5"; }],
  ["boolean value", (p) => { p.value = true; }],
  ["infinite value", (p) => { p.value = 1e400; }],
  ["invalid metric", (p) => { p.metric = "Air Temperature"; }],
  ["invalid unit", (p) => { p.unit = ""; }],
  ["timezone-free timestamp", (p) => { p.observed_at = "2026-11-10T14:55:00"; }],
  ["invalid timestamp", (p) => { p.observed_at = "not-a-date"; }],
  ["impossible calendar date", (p) => { p.observed_at = "2026-02-31T14:55:00Z"; }],
  ["invalid timezone offset", (p) => { p.observed_at = "2026-11-10T14:55:00+25:00"; }],
  ["invalid clock time", (p) => { p.observed_at = "2026-11-10T24:00:00Z"; }],
  ["future timestamp", (p) => { p.observed_at = "2026-11-10T15:06:00Z"; }],
  ["unsupported acquisition method", (p) => { p.provenance.acquisition_method = "unverified_by_client"; }],
  ["duplicate quality flag", (p) => { p.quality_flags = ["estimated", "estimated"]; }],
  ["unknown quality flag", (p) => { p.quality_flags = ["trusted"]; }],
]) {
  test("rejects " + name, () => {
    const payload = structuredClone(valid);
    mutate(payload);
    assert.throws(() => validateObservationPayload(payload, now));
  });
}

test("accepts a site identifier at the UTF-16 code-unit boundary", () => {
  const payload = structuredClone(valid);
  payload.site_id = "😀".repeat(60);
  assert.equal(validateObservationPayload(payload, now).site_id, payload.site_id);
});

test("allows optional asset and quality flags to be omitted", () => {
  const payload = structuredClone(valid);
  delete payload.asset_id;
  delete payload.quality_flags;
  const result = validateObservationPayload(payload, now);
  assert.equal(result.asset_id, undefined);
  assert.deepEqual(result.quality_flags, []);
});
