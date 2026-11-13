import test from "node:test";
import assert from "node:assert/strict";
import { resolveWaterQualitySampleEvidence } from "../src/water-quality-sample-evidence.mjs";

const sample = {
  parameter: "electrical_conductivity", value: 1.5, unit: "dS/m",
  sampled_at: "2026-05-10T10:00:00Z",
  provenance: { source_type: "measured", method: "field_meter", evidence_ref: "observation:obs-1" },
};
const stored = {
  id: "obs-1", tenant_id: "tenant-a", site_id: "site-a",
  metric: "electrical_conductivity", value: 1.5, unit: "dS/m",
  observed_at: "2026-05-10T10:00:00Z", verification_status: "verified",
};
function dbFor(rows) {
  const calls = [];
  return { calls, prepare(sql) { return { bind(...args) { calls.push({ sql, args }); return {
    async all() { return { results: rows }; },
  }; } }; } };
}

test("accepts only an exact verified observation in the requested tenant and site", async () => {
  const db = dbFor([stored]);
  assert.deepEqual(await resolveWaterQualitySampleEvidence(db, "tenant-a", "site-a", sample),
    { eligible: true, verification_status: "matched_to_verified_core_observation" });
  assert.match(db.calls[0].sql, /tenant_id = \? AND site_id = \?/);
  assert.deepEqual(db.calls[0].args, ["obs-1", "tenant-a", "site-a"]);
});

test("rejects missing, duplicate, unverified and mismatched persisted observations", async () => {
  assert.equal((await resolveWaterQualitySampleEvidence(dbFor([]), "tenant-a", "site-a", sample)).reason,
    "persisted_observation_not_found_in_site_scope");
  assert.equal((await resolveWaterQualitySampleEvidence(dbFor([stored, stored]), "tenant-a", "site-a", sample)).reason,
    "persisted_observation_not_found_in_site_scope");
  assert.equal((await resolveWaterQualitySampleEvidence(dbFor([{ ...stored, verification_status: "unverified" }]),
    "tenant-a", "site-a", sample)).reason, "persisted_observation_not_verified");
  assert.equal((await resolveWaterQualitySampleEvidence(dbFor([{ ...stored, value: 9 }]),
    "tenant-a", "site-a", sample)).reason, "persisted_observation_payload_mismatch");
});

test("rejects caller references outside the persisted observation namespace", async () => {
  const invalid = { ...sample, provenance: { ...sample.provenance, evidence_ref: "report:123" } };
  assert.equal((await resolveWaterQualitySampleEvidence(dbFor([stored]), "tenant-a", "site-a", invalid)).reason,
    "persisted_observation_reference_required");
});

test("does not promote synthetic, laboratory or modelled references to verified field evidence", async () => {
  for (const source_type of ["synthetic", "laboratory", "modelled"]) {
    const candidate = { ...sample, provenance: { ...sample.provenance, source_type } };
    const result = await resolveWaterQualitySampleEvidence(dbFor([stored]), "tenant-a", "site-a", candidate);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, source_type === "synthetic"
      ? "synthetic_sample_not_eligible_for_field_assessment"
      : "external_evidence_verification_not_configured");
  }
});
