import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  validateSourceEvidenceDocumentDraft,
  prepareSourceEvidenceDocument,
  validateSourceDataRightsDraft,
  prepareSourceDataRightsDeclaration,
} from "../src/source-evidence-rights-contract.mjs";

const pdf = () => new TextEncoder().encode("%PDF-1.7");
const evidenceDraft = (overrides = {}) => ({
  document_type: "data_license",
  file_name: "provider-license.pdf",
  media_type: "application/pdf",
  issuer_name: "Verified provider",
  document_reference: "LIC-2026-001",
  issued_at: "2026-01-01T00:00:00Z",
  effective_from: "2026-01-01T00:00:00Z",
  effective_to: "2027-01-01T00:00:00Z",
  document_bytes: pdf(),
  ...overrides,
});
const rightsDraft = (overrides = {}) => ({
  asset_id: null,
  supporting_evidence_id: "source-evidence:document-001",
  provider_name: "Verified provider",
  controller_name: "Tenant data controller",
  basis_type: "license",
  instrument_reference: "LIC-2026-001",
  permitted_purposes: ["measurement_ingestion", "analytics"],
  restrictions: ["Do not disclose raw personal data"],
  effective_from: "2026-01-01T00:00:00Z",
  effective_to: "2027-01-01T00:00:00Z",
  ...overrides,
});

test("valid PDF evidence draft is accepted and actual bytes are SHA-256 hashed", async () => {
  const draft = evidenceDraft();
  assert.deepEqual(validateSourceEvidenceDocumentDraft(draft), { valid: true, errors: [] });
  const prepared = await prepareSourceEvidenceDocument({ draft, cryptoProvider: webcrypto });
  const expected = await webcrypto.subtle.digest("SHA-256", pdf());
  const expectedHex = Array.from(new Uint8Array(expected), b => b.toString(16).padStart(2, "0")).join("");
  assert.equal(prepared.sha256, expectedHex);
  assert.equal(prepared.byte_length, pdf().byteLength);
  assert.deepEqual(prepared.document_bytes, pdf());
  assert.equal("document_bytes" in draft, true);
});

test("evidence draft rejects path-like filenames, unsupported media and malformed dates", () => {
  assert.equal(validateSourceEvidenceDocumentDraft(evidenceDraft({ file_name: "../license.pdf" })).valid, false);
  assert.equal(validateSourceEvidenceDocumentDraft(evidenceDraft({ media_type: "text/plain" })).valid, false);
  assert.equal(validateSourceEvidenceDocumentDraft(evidenceDraft({ issued_at: "2026-02-30T00:00:00Z" })).valid, false);
  assert.equal(validateSourceEvidenceDocumentDraft(evidenceDraft({ effective_to: "2025-01-01T00:00:00Z" })).valid, false);
});

test("evidence draft rejects non-PDF bytes and documents above the one-MiB bound", () => {
  assert.equal(validateSourceEvidenceDocumentDraft(evidenceDraft({
    document_bytes: new TextEncoder().encode("not a pdf"),
  })).valid, false);
  assert.equal(validateSourceEvidenceDocumentDraft(evidenceDraft({
    document_bytes: new Uint8Array(1024 * 1024 + 1),
  })).valid, false);
});

test("evidence draft rejects unknown fields and control characters", () => {
  assert.equal(validateSourceEvidenceDocumentDraft(evidenceDraft({ caller_sha256: "a".repeat(64) })).valid, false);
  assert.equal(validateSourceEvidenceDocumentDraft(evidenceDraft({ issuer_name: "issuer\u0000spoof" })).valid, false);
});

test("valid rights declaration is accepted with explicitly listed purposes", () => {
  const draft = rightsDraft();
  assert.deepEqual(validateSourceDataRightsDraft(draft), { valid: true, errors: [] });
});

test("rights declaration rejects unsupported purpose, duplicates and invalid scope", () => {
  assert.equal(validateSourceDataRightsDraft(rightsDraft({
    permitted_purposes: ["measurement_ingestion", "unbounded_scraping"],
  })).valid, false);
  assert.equal(validateSourceDataRightsDraft(rightsDraft({
    permitted_purposes: ["analytics", "analytics"],
  })).valid, false);
  assert.equal(validateSourceDataRightsDraft(rightsDraft({
    supporting_evidence_id: "https://example.invalid/license.pdf",
  })).valid, false);
  assert.equal(validateSourceDataRightsDraft(rightsDraft({
    effective_to: "2025-12-31T00:00:00Z",
  })).valid, false);
});

test("rights declaration requires explicit model-training permission", async () => {
  const analyticsOnly = rightsDraft();
  const preparedAnalytics = await prepareSourceDataRightsDeclaration({
    draft: analyticsOnly, tenantId: "tenant-a", siteId: "site-a", sourceId: "source-a",
    principalSubject: "reviewable-tenant-owner", evidenceSha256: "a".repeat(64),
    cryptoProvider: webcrypto,
  });
  assert.deepEqual(JSON.parse(preparedAnalytics.permitted_purposes_json),
    ["analytics", "measurement_ingestion"]);
  assert.equal(JSON.parse(preparedAnalytics.permitted_purposes_json).includes("model_training"), false);

  const withTraining = rightsDraft({
    permitted_purposes: ["model_training", "measurement_ingestion"],
  });
  const preparedTraining = await prepareSourceDataRightsDeclaration({
    draft: withTraining, tenantId: "tenant-a", siteId: "site-a", sourceId: "source-a",
    principalSubject: "reviewable-tenant-owner", evidenceSha256: "a".repeat(64),
    cryptoProvider: webcrypto,
  });
  assert.deepEqual(JSON.parse(preparedTraining.permitted_purposes_json),
    ["measurement_ingestion", "model_training"]);
});

test("rights declaration digest is canonical and bound to tenant/source/evidence", async () => {
  const base = {
    tenantId: "tenant-a", siteId: "site-a", sourceId: "source-a",
    principalSubject: "tenant-owner", evidenceSha256: "a".repeat(64),
    cryptoProvider: webcrypto,
  };
  const first = await prepareSourceDataRightsDeclaration({ ...base, draft: rightsDraft() });
  const reordered = await prepareSourceDataRightsDeclaration({
    ...base,
    draft: rightsDraft({ permitted_purposes: ["analytics", "measurement_ingestion"] }),
  });
  assert.equal(first.declaration_sha256, reordered.declaration_sha256);

  const otherEvidence = await prepareSourceDataRightsDeclaration({
    ...base, evidenceSha256: "b".repeat(64), draft: rightsDraft(),
  });
  assert.notEqual(first.declaration_sha256, otherEvidence.declaration_sha256);
});

test("rights declaration rejects missing authority scope and malformed purpose arrays", async () => {
  await assert.rejects(() => prepareSourceDataRightsDeclaration({
    draft: rightsDraft(), tenantId: "tenant-a", siteId: "site-a", sourceId: "source-a",
    principalSubject: "tenant-owner", evidenceSha256: "not-a-digest", cryptoProvider: webcrypto,
  }), /source_data_rights_declaration_invalid/);
  assert.equal(validateSourceDataRightsDraft(rightsDraft({
    permitted_purposes: [],
  })).valid, false);
});

console.log("Source evidence and data-rights contract tests passed");
