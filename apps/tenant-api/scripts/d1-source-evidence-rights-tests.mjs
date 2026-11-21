import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const args = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];
function execute(label, statements, expectedError = null) {
  const command = statements.join(";\n");
  const result = spawnSync("npx", [...args, command], { encoding: "utf8" });
  const output = (result.stdout || "") + "\n" + (result.stderr || "");
  if (expectedError) {
    assert.notEqual(result.status, 0, label + " unexpectedly succeeded\n" + output);
    assert.match(output, new RegExp(expectedError), label + " failed for an unexpected reason\n" + output);
    console.log("Rejected as expected: " + label);
    return;
  }
  assert.equal(result.status, 0, label + " failed\n" + output);
  console.log("Passed: " + label);
}
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
function audit(id, actor, action, entityType, entityId, requestId, details = "{}") {
  return `INSERT INTO audit_events
    (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json)
    VALUES (${q(id)},'tenant-http-a','operator',${q(actor)},${q(action)},${q(entityType)},
      ${q(entityId)},strftime('%Y-%m-%dT%H:%M:%fZ','now'),${q(requestId)},${q(details)})`;
}
function evidenceEvent(id, evidenceId, actor, type, digest, requestId, reason = null) {
  return `INSERT INTO source_evidence_events
    (id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id)
    VALUES (${q(id)},${q(evidenceId)},'tenant-http-a','site-http-a','source-http-a',
      ${q(actor)},${q(type)},${q(digest)},${reason === null ? "NULL" : q(reason)},${q(requestId)})`;
}
function rightsEvent(id, declarationId, actor, type, declarationDigest, evidenceDigest, requestId, reason = null) {
  return `INSERT INTO source_data_rights_events
    (id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,
     reviewed_declaration_sha256,reviewed_evidence_sha256,reason,request_id)
    VALUES (${q(id)},${q(declarationId)},'tenant-http-a','site-http-a','source-http-a',
      ${q(actor)},${q(type)},${q(declarationDigest)},${q(evidenceDigest)},
      ${reason === null ? "NULL" : q(reason)},${q(requestId)})`;
}
const uploader = "ci-human-subject";
const reviewer = "ci-measurement-reviewer";
const evidenceId = "source-evidence:ci-doc-verified";
const evidenceDigest = "a".repeat(64);
const declarationId = "source-rights:ci-rights-approved";
const declarationDigest = "b".repeat(64);

execute("register immutable source evidence document with matching audit", [
  audit("audit-ci-evidence-create", uploader, "source_evidence.registered",
    "source_evidence_document", evidenceId, "req-ci-evidence-create"),
  `INSERT INTO source_evidence_documents
    (id,tenant_id,site_id,source_id,document_type,file_name,media_type,byte_length,sha256,
     document_bytes,issuer_name,document_reference,issued_at,effective_from,effective_to,
     uploaded_by_subject,request_id)
    VALUES (${q(evidenceId)},'tenant-http-a','site-http-a','source-http-a','data_license',
      'license.pdf','application/pdf',5,${q(evidenceDigest)},X'255044462D','CI synthetic provider',
      'CI-LICENSE-001','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',
      '2027-01-01T00:00:00Z',${q(uploader)},'req-ci-evidence-create')`,
  audit("audit-ci-evidence-registered", uploader, "source_evidence.registered",
    "source_evidence_document", evidenceId, "req-ci-evidence-registered"),
  evidenceEvent("event-ci-evidence-registered", evidenceId, uploader, "registered",
    evidenceDigest, "req-ci-evidence-registered"),
]);

execute("evidence uploader cannot self-verify", [
  audit("audit-ci-evidence-self-verify", uploader, "source_evidence.verified",
    "source_evidence_document", evidenceId, "req-ci-evidence-self-verify"),
  evidenceEvent("event-ci-evidence-self-verify", evidenceId, uploader, "verified",
    evidenceDigest, "req-ci-evidence-self-verify"),
], "source evidence event requires exact digest, lifecycle and independent reviewer authority");

execute("evidence reviewer cannot substitute a different digest", [
  audit("audit-ci-evidence-bad-digest", reviewer, "source_evidence.verified",
    "source_evidence_document", evidenceId, "req-ci-evidence-bad-digest"),
  evidenceEvent("event-ci-evidence-bad-digest", evidenceId, reviewer, "verified",
    "c".repeat(64), "req-ci-evidence-bad-digest"),
], "source evidence event requires exact digest, lifecycle and independent reviewer authority");

execute("independent assigned reviewer verifies exact evidence digest", [
  audit("audit-ci-evidence-verified", reviewer, "source_evidence.verified",
    "source_evidence_document", evidenceId, "req-ci-evidence-verified"),
  evidenceEvent("event-ci-evidence-verified", evidenceId, reviewer, "verified",
    evidenceDigest, "req-ci-evidence-verified"),
]);

execute("verified evidence document is immutable", [
  "UPDATE source_evidence_documents SET issuer_name='tampered' WHERE id=" + q(evidenceId),
], "source evidence documents are immutable");
execute("evidence events cannot be deleted", [
  "DELETE FROM source_evidence_events WHERE id='event-ci-evidence-verified'",
], "source evidence events cannot be deleted");

execute("create immutable rights declaration tied to verified evidence", [
  audit("audit-ci-rights-create", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", declarationId, "req-ci-rights-create"),
  `INSERT INTO source_data_rights_declarations
    (id,tenant_id,site_id,source_id,asset_id,supporting_evidence_id,supporting_evidence_sha256,
     provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,
     restrictions_json,effective_from,effective_to,declaration_sha256,declared_by_subject,request_id)
    VALUES (${q(declarationId)},'tenant-http-a','site-http-a','source-http-a',NULL,
      ${q(evidenceId)},${q(evidenceDigest)},'CI synthetic provider','NeoHaven CI tenant controller',
      'license','CI-LICENSE-001','["measurement_ingestion","analytics"]','[]',
      '2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',${q(declarationDigest)},
      ${q(uploader)},'req-ci-rights-create')`,
  audit("audit-ci-rights-declared", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", declarationId, "req-ci-rights-declared"),
  rightsEvent("event-ci-rights-declared", declarationId, uploader, "declared",
    declarationDigest, evidenceDigest, "req-ci-rights-declared"),
]);

execute("rights reviewer cannot approve a different declaration digest", [
  audit("audit-ci-rights-bad-digest", reviewer, "source_data_rights.approved",
    "source_data_rights_declaration", declarationId, "req-ci-rights-bad-digest"),
  rightsEvent("event-ci-rights-bad-digest", declarationId, reviewer, "approved",
    "c".repeat(64), evidenceDigest, "req-ci-rights-bad-digest"),
], "data rights event requires exact declaration and evidence digests, valid lifecycle and independent reviewer authority");

execute("independent reviewer approves exact active rights declaration", [
  audit("audit-ci-rights-approved", reviewer, "source_data_rights.approved",
    "source_data_rights_declaration", declarationId, "req-ci-rights-approved"),
  rightsEvent("event-ci-rights-approved", declarationId, reviewer, "approved",
    declarationDigest, evidenceDigest, "req-ci-rights-approved"),
]);

execute("rights declaration cannot be edited after review", [
  "UPDATE source_data_rights_declarations SET provider_name='tampered' WHERE id=" + q(declarationId),
], "source data rights declarations are immutable");
execute("rights event history cannot be deleted", [
  "DELETE FROM source_data_rights_events WHERE id='event-ci-rights-approved'",
], "source data rights events cannot be deleted");

execute("approved rights can be revoked by an independent assigned reviewer", [
  audit("audit-ci-rights-revoked", reviewer, "source_data_rights.revoked",
    "source_data_rights_declaration", declarationId, "req-ci-rights-revoked"),
  rightsEvent("event-ci-rights-revoked", declarationId, reviewer, "revoked",
    declarationDigest, evidenceDigest, "req-ci-rights-revoked", "Provider revoked the test license"),
]);

const expiredId = "source-rights:ci-rights-expired";
const expiredDigest = "d".repeat(64);
execute("record historical expired rights declaration", [
  audit("audit-ci-rights-expired-create", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", expiredId, "req-ci-rights-expired-create"),
  `INSERT INTO source_data_rights_declarations
    (id,tenant_id,site_id,source_id,supporting_evidence_id,supporting_evidence_sha256,
     provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,
     restrictions_json,effective_from,effective_to,declaration_sha256,declared_by_subject,request_id)
    VALUES (${q(expiredId)},'tenant-http-a','site-http-a','source-http-a',${q(evidenceId)},
      ${q(evidenceDigest)},'CI synthetic provider','CI tenant controller','license','CI-EXPIRED',
      '["measurement_ingestion"]','[]','2025-01-01T00:00:00Z','2026-01-01T00:00:00Z',
      ${q(expiredDigest)},${q(uploader)},'req-ci-rights-expired-create')`,
  audit("audit-ci-rights-expired-declared", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", expiredId, "req-ci-rights-expired-declared"),
  rightsEvent("event-ci-rights-expired-declared", expiredId, uploader, "declared",
    expiredDigest, evidenceDigest, "req-ci-rights-expired-declared"),
]);

execute("expired rights cannot be approved", [
  audit("audit-ci-rights-expired-approved", reviewer, "source_data_rights.approved",
    "source_data_rights_declaration", expiredId, "req-ci-rights-expired-approved"),
  rightsEvent("event-ci-rights-expired-approved", expiredId, reviewer, "approved",
    expiredDigest, evidenceDigest, "req-ci-rights-expired-approved"),
], "data rights event requires exact declaration and evidence digests, valid lifecycle and independent reviewer authority");

execute("rights declaration rejects unsupported purposes", [
  audit("audit-ci-rights-purpose-invalid", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", "source-rights:ci-rights-invalid-purpose", "req-ci-rights-invalid-purpose"),
  `INSERT INTO source_data_rights_declarations
    (id,tenant_id,site_id,source_id,supporting_evidence_id,supporting_evidence_sha256,
     provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,
     restrictions_json,effective_from,declaration_sha256,declared_by_subject,request_id)
    VALUES ('source-rights:ci-rights-invalid-purpose','tenant-http-a','site-http-a','source-http-a',
      ${q(evidenceId)},${q(evidenceDigest)},'CI provider','CI controller','other','CI-INVALID',
      '["unbounded_scraping"]','[]','2026-01-01T00:00:00Z',${q("e".repeat(64))},
      ${q(uploader)},'req-ci-rights-invalid-purpose')`,
], "data rights declaration requires verified scoped evidence, active authority and explicit valid purposes");

execute("rights declaration rejects a mismatched supporting evidence digest", [
  audit("audit-ci-rights-evidence-mismatch", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", "source-rights:ci-rights-evidence-mismatch", "req-ci-rights-evidence-mismatch"),
  `INSERT INTO source_data_rights_declarations
    (id,tenant_id,site_id,source_id,supporting_evidence_id,supporting_evidence_sha256,
     provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,
     restrictions_json,effective_from,declaration_sha256,declared_by_subject,request_id)
    VALUES ('source-rights:ci-rights-evidence-mismatch','tenant-http-a','site-http-a','source-http-a',
      ${q(evidenceId)},${q("f".repeat(64))},'CI provider','CI controller','other','CI-MISMATCH',
      '["measurement_ingestion"]','[]','2026-01-01T00:00:00Z',${q("f".repeat(64))},
      ${q(uploader)},'req-ci-rights-evidence-mismatch')`,
], "FOREIGN KEY constraint failed");

execute("inspect canonical rights purpose scope", [
  "SELECT id,permitted_purposes_json FROM source_data_rights_declarations WHERE id=" + q(declarationId),
]);
console.log("Source evidence and data-rights governance D1 tests passed");
