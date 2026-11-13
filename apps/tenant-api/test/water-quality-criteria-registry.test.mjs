import test from "node:test";
import assert from "node:assert/strict";
import {
  validateWaterQualityCriteriaRegistryEntry,
  resolveApprovedWaterQualityCriteria,
} from "../src/water-quality-criteria-registry.mjs";

const entry = {
  id: "tn-water-quality-2026",
  jurisdiction: "TN",
  title: "Illustrative criteria record (test fixture only)",
  version: "1.0.0",
  published_on: "2026-01-01",
  effective_from: "2026-02-01",
  authority: {
    name: "Fixture authority",
    source_evidence_ref: "evidence:source-document",
    document_digest: "sha256:" + "a".repeat(64),
  },
  scope: {
    tenant_id: "tenant-a",
    site_id: "site-1",
    crop_ids: ["olive"],
    irrigation_methods: ["drip"],
    intended_uses: ["agricultural_irrigation"],
  },
  criteria: [{
    parameter: "electrical_conductivity",
    unit: "dS/m",
    operator: "max",
    value: 2,
    reference_clause: "fixture clause 1",
    evidence_ref: "evidence:clause-1",
  }],
  review: {
    status: "approved",
    approvals: [
      { reviewer_id: "reviewer-reg", role: "regulatory_reviewer", reviewed_at: "2026-01-15T10:00:00Z", evidence_ref: "evidence:review-reg" },
      { reviewer_id: "reviewer-domain", role: "domain_expert", reviewed_at: "2026-01-16T10:00:00Z", evidence_ref: "evidence:review-domain" },
    ],
  },
};
const context = {
  tenant_id: "tenant-a", site_id: "site-1", jurisdiction: "TN",
  crop_id: "olive", irrigation_method: "drip",
  intended_use: "agricultural_irrigation",
};

test("validates explicit source, version, dates, scope and reviewer evidence", () => {
  assert.equal(validateWaterQualityCriteriaRegistryEntry(entry).valid, true);
});

test("requires separate regulatory and domain-expert approval roles", () => {
  const oneRole = structuredClone(entry);
  oneRole.review.approvals[1].role = "regulatory_reviewer";
  assert.equal(validateWaterQualityCriteriaRegistryEntry(oneRole).errors[0].code,
    "review.independent_role_approvals_required");
  const samePerson = structuredClone(entry);
  samePerson.review.approvals[1].reviewer_id = "reviewer-reg";
  assert.equal(validateWaterQualityCriteriaRegistryEntry(samePerson).valid, false);
});

test("does not resolve draft, pending, rejected, superseded or retired entries", () => {
  for (const status of ["draft", "review_pending", "rejected", "superseded", "retired"]) {
    const candidate = { ...entry, review: { status, approvals: [] } };
    assert.equal(resolveApprovedWaterQualityCriteria(candidate, context, "2026-03-01T00:00:00Z").reason,
      "registry_entry_not_approved");
  }
});

test("requires exact tenant, site, jurisdiction, crop, method and intended-use scope", () => {
  for (const change of [
    { tenant_id: "tenant-b" }, { site_id: "site-2" }, { jurisdiction: "XX" },
    { crop_id: "citrus" }, { irrigation_method: "sprinkler" }, { intended_use: "other" },
  ]) {
    const result = resolveApprovedWaterQualityCriteria(entry, { ...context, ...change }, "2026-03-01T00:00:00Z");
    assert.equal(result.reason, "registry_scope_mismatch");
  }
});

test("does not resolve entries before or after their effective period", () => {
  assert.equal(resolveApprovedWaterQualityCriteria(entry, context, "2026-01-31T23:59:59Z").reason,
    "registry_entry_not_effective_on_sample_date");
  const expired = { ...entry, effective_to: "2026-02-28" };
  assert.equal(resolveApprovedWaterQualityCriteria(expired, context, "2026-03-01T00:00:00Z").reason,
    "registry_entry_not_effective_on_sample_date");
});

test("requires valid calendar dates and cryptographic digest shape", () => {
  const invalidDate = { ...entry, effective_from: "2026-02-30" };
  assert.equal(validateWaterQualityCriteriaRegistryEntry(invalidDate).valid, false);
  const invalidDigest = { ...entry, authority: { ...entry.authority, document_digest: "sha256:unknown" } };
  assert.equal(validateWaterQualityCriteriaRegistryEntry(invalidDigest).valid, false);
});

test("returns an approved scope match without asserting legal or operational validity", () => {
  const result = resolveApprovedWaterQualityCriteria(entry, context, "2026-03-01T00:00:00Z");
  assert.equal(result.status, "approved_entry_scope_match");
  assert.equal(result.legal_status, "not_independently_verified");
  assert.equal(result.source_authenticity, "not_independently_verified");
  assert.equal(result.operational_decision, "not_authorized");
});
