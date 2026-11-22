import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const args = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
function execute(label, statements, expectedError = null) {
  const sql = statements.join(";\n");
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
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
function capability(id, metric, rightsId, evidenceId, assetId = null) {
  return `INSERT INTO source_capabilities
    (id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,
     quantity_semantics,acquisition_protocol,protocol_version,sampling_mode,interval_seconds,
     max_age_seconds,max_future_skew_seconds,timezone,allowed_quality_flags_json,
     calibration_required,calibration_profile_ref,data_rights_ref,evidence_ref,version,status,created_by_subject)
    VALUES (${q(id)},'tenant-http-a','site-http-a','source-http-grant',${assetId === null ? "NULL" : q(assetId)},
     'neoagro',${q(metric)},'dS/m','measured','Synthetic CI rights guard metric','manual-lab','1.0',
     'interval',3600,31536000,300,'Africa/Tunis','[]',0,NULL,${q(rightsId)},${q(evidenceId)},1,'pending','ci-human-subject')`;
}
function submitted(id, eventId, requestId) {
  return `INSERT INTO source_capability_events
    (id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
    VALUES (${q(eventId)},${q(id)},'tenant-http-a','site-http-a','source-http-grant',
      'ci-human-subject','submitted','fixture:rights-guard-submit',NULL,${q(requestId)})`;
}
function approval(id, eventId, requestId) {
  return `INSERT INTO source_capability_events
    (id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
    VALUES (${q(eventId)},${q(id)},'tenant-http-a','site-http-a','source-http-grant',
      'ci-measurement-reviewer','approved','fixture:rights-guard-approve',NULL,${q(requestId)})`;
}
function observation(id, capabilityId, metric, assetId = null) {
  return `INSERT INTO observations
    (id,site_id,tenant_id,asset_id,source_id,module,metric,value,unit,observed_at,idempotency_key,
     verification_status,provenance_json,quality_flags_json,source_capability_id,measurement_kind,
     acquisition_protocol,protocol_version,sampling_mode,sampling_interval_seconds)
    VALUES (${q(id)},'site-http-a','tenant-http-a',${assetId === null ? "NULL" : q(assetId)},
     'source-http-grant','neoagro',${q(metric)},1.25,'dS/m',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
     ${q("idem-"+id)},'unverified','{}','[]',${q(capabilityId)},'measured','manual-lab','1.0','interval',3600)`;
}

// A complete positive path: exact site/source/asset scope, current verified evidence,
// independently approved rights, and both ingestion + storage purposes.
const positiveId = "capability-rights-guard-positive";
const positiveMetric = "rights_guard_positive";
execute("create and independently approve capability with exact current rights", [
  capability(positiveId,positiveMetric,"source-rights:ci-http-grant","source-evidence:ci-http-grant"),
  submitted(positiveId,"event-rights-guard-positive-submitted","req-rights-guard-positive-submit"),
  approval(positiveId,"event-rights-guard-positive-approved","req-rights-guard-positive-approve"),
]);
execute("accept observation while exact rights and evidence remain current", [
  observation("obs-rights-guard-positive",positiveId,positiveMetric),
]);

// Create an independently approved rights declaration which deliberately omits storage.
// Capability approval must reject it even though measurement_ingestion is present.
const noStorageId = "source-rights:ci-no-storage";
const noStorageDigest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
execute("create approved rights declaration without storage purpose", [
  `INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json)
   VALUES ('audit-ci-no-storage-declared','tenant-http-a','operator','ci-human-subject',
   'source_data_rights.declared','source_data_rights_declaration',${q(noStorageId)},
   strftime('%Y-%m-%dT%H:%M:%fZ','now'),'req-ci-no-storage-declared','{}')`,
  `INSERT INTO source_data_rights_declarations
   (id,tenant_id,site_id,source_id,asset_id,supporting_evidence_id,supporting_evidence_sha256,
    provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,
    restrictions_json,effective_from,effective_to,declaration_sha256,declared_by_subject,request_id)
   VALUES (${q(noStorageId)},'tenant-http-a','site-http-a','source-http-grant',NULL,
    'source-evidence:ci-http-grant','4318c92710ae19a064071f683dd4dd1fabbb1c67be0cce234302fbf8690a63b5',
    'Synthetic CI provider','CI tenant controller','license','CI-NO-STORAGE',
    '["measurement_ingestion","analytics"]','[]','2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',
    ${q(noStorageDigest)},'ci-human-subject','req-ci-no-storage-declared')`,
  `INSERT INTO source_data_rights_events
   (id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,
    reviewed_evidence_sha256,reason,request_id)
   VALUES ('event-ci-no-storage-declared',${q(noStorageId)},'tenant-http-a','site-http-a','source-http-grant',
    'ci-human-subject','declared',${q(noStorageDigest)},
    '4318c92710ae19a064071f683dd4dd1fabbb1c67be0cce234302fbf8690a63b5',NULL,'req-ci-no-storage-declared')`,
  `INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json)
   VALUES ('audit-ci-no-storage-approved','tenant-http-a','operator','ci-measurement-reviewer',
   'source_data_rights.approved','source_data_rights_declaration',${q(noStorageId)},
   strftime('%Y-%m-%dT%H:%M:%fZ','now'),'req-ci-no-storage-approved','{}')`,
  `INSERT INTO source_data_rights_events
   (id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,
    reviewed_evidence_sha256,reason,request_id)
   VALUES ('event-ci-no-storage-approved',${q(noStorageId)},'tenant-http-a','site-http-a','source-http-grant',
    'ci-measurement-reviewer','approved',${q(noStorageDigest)},
    '4318c92710ae19a064071f683dd4dd1fabbb1c67be0cce234302fbf8690a63b5',NULL,'req-ci-no-storage-approved')`,
  capability("capability-rights-guard-no-storage","rights_guard_no_storage",noStorageId,"source-evidence:ci-http-grant"),
  submitted("capability-rights-guard-no-storage","event-rights-guard-no-storage-submitted","req-rights-guard-no-storage-submit"),
]);
execute("deny capability approval when storage purpose is absent", [
  approval("capability-rights-guard-no-storage","event-rights-guard-no-storage-approved","req-rights-guard-no-storage-approve"),
], "capability approval requires current exact-scope approved ingestion and storage rights");

// A rights reference that does not resolve and a valid declaration paired with
// the wrong evidence document must both fail closed at approval.
execute("prepare unresolved and mismatched evidence capability drafts", [
  capability("capability-rights-guard-unresolved","rights_guard_unresolved",
    "source-rights:missing","source-evidence:missing"),
  submitted("capability-rights-guard-unresolved","event-rights-guard-unresolved-submitted","req-rights-guard-unresolved-submit"),
  capability("capability-rights-guard-evidence-mismatch","rights_guard_evidence_mismatch",
    "source-rights:ci-http-grant","source-evidence:ci-http-grant-asset"),
  submitted("capability-rights-guard-evidence-mismatch","event-rights-guard-evidence-mismatch-submitted","req-rights-guard-evidence-mismatch-submit"),
]);
execute("deny capability approval with unresolved rights reference", [
  approval("capability-rights-guard-unresolved","event-rights-guard-unresolved-approved","req-rights-guard-unresolved-approve"),
], "capability approval requires current exact-scope approved ingestion and storage rights");
execute("deny capability approval with mismatched supporting evidence", [
  approval("capability-rights-guard-evidence-mismatch","event-rights-guard-evidence-mismatch-approved","req-rights-guard-evidence-mismatch-approve"),
], "capability approval requires current exact-scope approved ingestion and storage rights");

// Revoke the approved rights declaration. Existing history remains intact, but
// a new observation must fail at the commit boundary.
execute("independently revoke approved rights declaration", [
  `INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json)
   VALUES ('audit-ci-rights-guard-revoked','tenant-http-a','operator','ci-measurement-reviewer',
   'source_data_rights.revoked','source_data_rights_declaration','source-rights:ci-http-grant',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'),'req-ci-rights-guard-revoked','{}')`,
  `INSERT INTO source_data_rights_events
   (id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,
    reviewed_evidence_sha256,reason,request_id)
   VALUES ('event-ci-rights-guard-revoked','source-rights:ci-http-grant','tenant-http-a','site-http-a',
    'source-http-grant','ci-measurement-reviewer','revoked',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '4318c92710ae19a064071f683dd4dd1fabbb1c67be0cce234302fbf8690a63b5',
    'CI rights withdrawal','req-ci-rights-guard-revoked')`,
]);
execute("deny new observation after rights revocation", [
  observation("obs-rights-guard-after-rights-revocation","capability-http-guard-site","ec"),
], "observation requires current exact-scope approved ingestion and storage rights");

// Revoke supporting evidence for the separately asset-scoped capability while
// leaving its rights declaration approved; the observation guard must recheck
// evidence lifecycle independently.
execute("independently revoke supporting evidence", [
  `INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json)
   VALUES ('audit-ci-evidence-guard-revoked','tenant-http-a','operator','ci-measurement-reviewer',
   'source_evidence.revoked','source_evidence_document','source-evidence:ci-http-grant-asset',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'),'req-ci-evidence-guard-revoked','{}')`,
  `INSERT INTO source_evidence_events
   (id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id)
   VALUES ('event-ci-evidence-guard-revoked','source-evidence:ci-http-grant-asset','tenant-http-a','site-http-a',
    'source-http-grant','ci-measurement-reviewer','revoked',
    '5df2ee69a0617d6ce6522a0f6e6e66e33d0d56cffc9fcecc95074fbc870620ee',
    'CI evidence withdrawal','req-ci-evidence-guard-revoked')`,
]);
execute("deny new observation after evidence revocation", [
  observation("obs-rights-guard-after-evidence-revocation","capability-http-grant","soil_moisture","asset-http-grant"),
], "observation requires current exact-scope approved ingestion and storage rights");

console.log("Source data-rights capability and observation guards passed");
