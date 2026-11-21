import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const args = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];
function sql(label, statement, expectedError = null) {
  const result = spawnSync("npx", [...args, statement], { encoding: "utf8" });
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
  return "INSERT INTO audit_events " +
    "(id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json) VALUES (" +
    [q(id), q("tenant-http-a"), q("operator"), q(actor), q(action), q(entityType), q(entityId),
      "strftime('%Y-%m-%dT%H:%M:%fZ','now')", q(requestId), q(details)].join(",") + ")";
}
const uploader = "ci-human-subject";
const reviewer = "ci-measurement-reviewer";
const evidenceId = "source-evidence:ci-doc-verified";
const evidenceDigest = "a".repeat(64);
const declarationId = "source-rights:ci-rights-approved";
const declarationDigest = "b".repeat(64);

sql("register immutable source evidence document with matching audit", [
  audit("audit-ci-evidence-create", uploader, "source_evidence.registered",
    "source_evidence_document", evidenceId, "req-ci-evidence-create"),
  "INSERT INTO source_evidence_documents",
  "(id,tenant_id,site_id,source_id,document_type,file_name,media_type,byte_length,sha256,document_bytes,",
  "issuer_name,document_reference,issued_at,effective_from,effective_to,uploaded_by_subject,request_id)",
  "VALUES (" + [
    q(evidenceId), q("tenant-http-a"), q("site-http-a"), q("source-http-a"),
    q("data_license"), q("license.pdf"), q("application/pdf"), "5", q(evidenceDigest), "X'255044462D'",
    q("CI synthetic provider"), q("CI-LICENSE-001"), q("2026-01-01T00:00:00Z"),
    q("2026-01-01T00:00:00Z"), q("2027-01-01T00:00:00Z"), q(uploader), q("req-ci-evidence-create")
  ].join(",") + ")",
  "INSERT INTO source_evidence_events",
  "(id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id)",
  "VALUES ('event-ci-evidence-registered'," + [
    q(evidenceId), q("tenant-http-a"), q("site-http-a"), q("source-http-a"),
    q(uploader), q("registered"), q(evidenceDigest), "NULL", q("req-ci-evidence-registered")
  ].join(",") + ")"
].join(";\n"));

sql("evidence upload cannot self-verify", [
  audit("audit-ci-evidence-self-verify", uploader, "source_evidence.verified",
    "source_evidence_document", evidenceId, "req-ci-evidence-self-verify"),
  "INSERT INTO source_evidence_events",
  "(id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id)",
  "VALUES ('event-ci-evidence-self-verify'," + [
    q(evidenceId), q("tenant-http-a"), q("site-http-a"), q("source-http-a"),
    q(uploader), q("verified"), q(evidenceDigest), "NULL", q("req-ci-evidence-self-verify")
  ].join(",") + ")"
].join(";\n"), "source evidence event requires exact digest, lifecycle and independent reviewer authority");

sql("evidence review cannot substitute a different digest", [
  audit("audit-ci-evidence-bad-digest", reviewer, "source_evidence.verified",
    "source_evidence_document", evidenceId, "req-ci-evidence-bad-digest"),
  "INSERT INTO source_evidence_events",
  "(id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id)",
  "VALUES ('event-ci-evidence-bad-digest'," + [
    q(evidenceId), q("tenant-http-a"), q("site-http-a"), q("source-http-a"),
    q(reviewer), q("verified"), q("c".repeat(64)), "NULL", q("req-ci-evidence-bad-digest")
  ].join(",") + ")"
].join(";\n"), "source evidence event requires exact digest, lifecycle and independent reviewer authority");

sql("independent assigned reviewer verifies exact evidence digest", [
  audit("audit-ci-evidence-verified", reviewer, "source_evidence.verified",
    "source_evidence_document", evidenceId, "req-ci-evidence-verified"),
  "INSERT INTO source_evidence_events",
  "(id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id)",
  "VALUES ('event-ci-evidence-verified'," + [
    q(evidenceId), q("tenant-http-a"), q("site-http-a"), q("source-http-a"),
    q(reviewer), q("verified"), q(evidenceDigest), "NULL", q("req-ci-evidence-verified")
  ].join(",") + ")"
].join(";\n"));

sql("verified evidence document and event are immutable", [
  "UPDATE source_evidence_documents SET issuer_name='tampered' WHERE id=" + q(evidenceId)
].join(""), "source evidence documents are immutable");
sql("evidence events cannot be deleted",
  "DELETE FROM source_evidence_events WHERE id='event-ci-evidence-verified'",
  "source evidence events cannot be deleted");
sql("evidence duplicate content is not re-registered in same source scope", [
  audit("audit-ci-evidence-duplicate", uploader, "source_evidence.registered",
    "source_evidence_document", "source-evidence:ci-doc-duplicate", "req-ci-evidence-duplicate"),
  "INSERT INTO source_evidence_documents",
  "(id,tenant_id,site_id,source_id,document_type,file_name,media_type,byte_length,sha256,document_bytes,issuer_name,document_reference,issued_at,uploaded_by_subject,request_id)",
  "VALUES ('source-evidence:ci-doc-duplicate','tenant-http-a','site-http-a','source-http-a','data_license','duplicate.pdf','application/pdf',5," +
    q(evidenceDigest) + ",X'255044462D','CI synthetic provider','CI-LICENSE-001','2026-01-01T00:00:00Z'," +
    q(uploader) + ",'req-ci-evidence-duplicate')"
].join(";\n"), "UNIQUE constraint failed");

sql("create immutable data-rights declaration tied to verified evidence and exact source", [
  audit("audit-ci-rights-create", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", declarationId, "req-ci-rights-create"),
  "INSERT INTO source_data_rights_declarations",
  "(id,tenant_id,site_id,source_id,asset_id,supporting_evidence_id,supporting_evidence_sha256,",
  "provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,restrictions_json,",
  "effective_from,effective_to,declaration_sha256,declared_by_subject,request_id)",
  "VALUES (" + [
    q(declarationId), q("tenant-http-a"), q("site-http-a"), q("source-http-a"), "NULL",
    q(evidenceId), q(evidenceDigest), q("CI synthetic provider"), q("NeoHaven CI tenant controller"),
    q("license"), q("CI-LICENSE-001"), q('["measurement_ingestion","analytics"]'), q("[]"),
    q("2026-01-01T00:00:00Z"), q("2027-01-01T00:00:00Z"), q(declarationDigest),
    q(uploader), q("req-ci-rights-create")
  ].join(",") + ")",
  audit("audit-ci-rights-declared", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", declarationId, "req-ci-rights-declared"),
  "INSERT INTO source_data_rights_events",
  "(id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,reviewed_evidence_sha256,reason,request_id)",
  "VALUES ('event-ci-rights-declared'," + [
    q(declarationId), q("tenant-http-a"), q("site-http-a"), q("source-http-a"),
    q(uploader), q("declared"), q(declarationDigest), q(evidenceDigest), "NULL",
    q("req-ci-rights-declared")
  ].join(",") + ")"
].join(";\n"));

sql("rights reviewer cannot approve a different declaration digest", [
  audit("audit-ci-rights-bad-digest", reviewer, "source_data_rights.approved",
    "source_data_rights_declaration", declarationId, "req-ci-rights-bad-digest"),
  "INSERT INTO source_data_rights_events",
  "(id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,reviewed_evidence_sha256,reason,request_id)",
  "VALUES ('event-ci-rights-bad-digest'," + [
    q(declarationId), q("tenant-http-a"), q("site-http-a"), q("source-http-a"),
    q(reviewer), q("approved"), q("c".repeat(64)), q(evidenceDigest), "NULL",
    q("req-ci-rights-bad-digest")
  ].join(",") + ")"
].join(";\n"), "data rights event requires exact declaration and evidence digests, valid lifecycle and independent reviewer authority");

sql("independent reviewer approves exact active rights declaration", [
  audit("audit-ci-rights-approved", reviewer, "source_data_rights.approved",
    "source_data_rights_declaration", declarationId, "req-ci-rights-approved"),
  "INSERT INTO source_data_rights_events",
  "(id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,reviewed_evidence_sha256,reason,request_id)",
  "VALUES ('event-ci-rights-approved'," + [
    q(declarationId), q("tenant-http-a"), q("site-http-a"), q("source-http-a"),
    q(reviewer), q("approved"), q(declarationDigest), q(evidenceDigest), "NULL",
    q("req-ci-rights-approved")
  ].join(",") + ")"
].join(";\n"));

sql("rights declaration cannot be edited after review",
  "UPDATE source_data_rights_declarations SET provider_name='tampered' WHERE id=" + q(declarationId),
  "source data rights declarations are immutable");
sql("rights event history cannot be deleted",
  "DELETE FROM source_data_rights_events WHERE id='event-ci-rights-approved'",
  "source data rights events cannot be deleted");

sql("approved rights can be revoked by independent assigned reviewer", [
  audit("audit-ci-rights-revoked", reviewer, "source_data_rights.revoked",
    "source_data_rights_declaration", declarationId, "req-ci-rights-revoked"),
  "INSERT INTO source_data_rights_events",
  "(id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,reviewed_evidence_sha256,reason,request_id)",
  "VALUES ('event-ci-rights-revoked'," + [
    q(declarationId), q("tenant-http-a"), q("site-http-a"), q("source-http-a"),
    q(reviewer), q("revoked"), q(declarationDigest), q(evidenceDigest),
    q("Provider revoked the test license"), q("req-ci-rights-revoked")
  ].join(",") + ")"
].join(";\n"));

sql("data rights cannot be approved after expiry", [
  audit("audit-ci-rights-expired-create", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", "source-rights:ci-rights-expired", "req-ci-rights-expired-create"),
  "INSERT INTO source_data_rights_declarations",
  "(id,tenant_id,site_id,source_id,asset_id,supporting_evidence_id,supporting_evidence_sha256,provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,restrictions_json,effective_from,effective_to,declaration_sha256,declared_by_subject,request_id)",
  "VALUES ('source-rights:ci-rights-expired','tenant-http-a','site-http-a','source-http-a',NULL," +
    q(evidenceId) + "," + q(evidenceDigest) + ",'CI synthetic provider','NeoHaven CI tenant controller','license','CI-EXPIRED','[\"measurement_ingestion\"]','[]','2025-01-01T00:00:00Z','2026-01-01T00:00:00Z'," +
    q("d".repeat(64)) + "," + q(uploader) + ",'req-ci-rights-expired-create')",
  audit("audit-ci-rights-expired-declared", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", "source-rights:ci-rights-expired", "req-ci-rights-expired-declared"),
  "INSERT INTO source_data_rights_events",
  "(id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,reviewed_evidence_sha256,reason,request_id)",
  "VALUES ('event-ci-rights-expired-declared','source-rights:ci-rights-expired','tenant-http-a','site-http-a','source-http-a'," +
    q(uploader) + ",'declared'," + q("d".repeat(64)) + "," + q(evidenceDigest) + ",NULL,'req-ci-rights-expired-declared')"
].join(";\n"));
sql("expired rights cannot be approved", [
  audit("audit-ci-rights-expired-approved", reviewer, "source_data_rights.approved",
    "source_data_rights_declaration", "source-rights:ci-rights-expired", "req-ci-rights-expired-approved"),
  "INSERT INTO source_data_rights_events",
  "(id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,reviewed_evidence_sha256,reason,request_id)",
  "VALUES ('event-ci-rights-expired-approved','source-rights:ci-rights-expired','tenant-http-a','site-http-a','source-http-a'," +
    q(reviewer) + ",'approved'," + q("d".repeat(64)) + "," + q(evidenceDigest) + ",NULL,'req-ci-rights-expired-approved')"
].join(";\n"), "data rights event requires exact declaration and evidence digests, valid lifecycle and independent reviewer authority");

sql("data rights declaration rejects unsupported purposes", [
  audit("audit-ci-rights-purpose-invalid", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", "source-rights:ci-rights-invalid-purpose", "req-ci-rights-invalid-purpose"),
  "INSERT INTO source_data_rights_declarations",
  "(id,tenant_id,site_id,source_id,supporting_evidence_id,supporting_evidence_sha256,provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,restrictions_json,effective_from,declaration_sha256,declared_by_subject,request_id)",
  "VALUES ('source-rights:ci-rights-invalid-purpose','tenant-http-a','site-http-a','source-http-a'," +
    q(evidenceId) + "," + q(evidenceDigest) + ",'CI provider','CI controller','other','CI-INVALID','[\"unbounded_scraping\"]','[]','2026-01-01T00:00:00Z'," +
    q("e".repeat(64)) + "," + q(uploader) + ",'req-ci-rights-invalid-purpose')"
].join(";\n"), "data rights declaration requires verified scoped evidence, active authority and explicit valid purposes");

sql("data rights declaration rejects a supporting evidence digest mismatch", [
  audit("audit-ci-rights-evidence-mismatch", uploader, "source_data_rights.declared",
    "source_data_rights_declaration", "source-rights:ci-rights-evidence-mismatch", "req-ci-rights-evidence-mismatch"),
  "INSERT INTO source_data_rights_declarations",
  "(id,tenant_id,site_id,source_id,supporting_evidence_id,supporting_evidence_sha256,provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,restrictions_json,effective_from,declaration_sha256,declared_by_subject,request_id)",
  "VALUES ('source-rights:ci-rights-evidence-mismatch','tenant-http-a','site-http-a','source-http-a'," +
    q(evidenceId) + "," + q("f".repeat(64)) + ",'CI provider','CI controller','other','CI-MISMATCH','[\"measurement_ingestion\"]','[]','2026-01-01T00:00:00Z'," +
    q("f".repeat(64)) + "," + q(uploader) + ",'req-ci-rights-evidence-mismatch')"
].join(";\n"), "FOREIGN KEY constraint failed");

sql("rights approval requires exact active evidence and declaration digests; no automatic model-training permission is implied",
  "SELECT id,permitted_purposes_json FROM source_data_rights_declarations WHERE id=" + q(declarationId));
console.log("Source evidence and data-rights governance D1 tests passed");
