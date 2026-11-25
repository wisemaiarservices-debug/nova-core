import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const args = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
function execute(label, statements, expectedError = null) {
  const sql = statements.join(";\\n");
  const result = spawnSync("npx", [...args, sql], { encoding: "utf8" });
  const output = (result.stdout || "") + "\\n" + (result.stderr || "");
  if (expectedError) {
    assert.notEqual(result.status, 0, label + " unexpectedly succeeded\\n" + output);
    assert.match(output, new RegExp(expectedError), label + " failed for an unexpected reason\\n" + output);
    console.log("Rejected as expected: " + label);
    return;
  }
  assert.equal(result.status, 0, label + " failed\\n" + output);
  return output;
}
function audit(id, actor, action, entityType, entityId, requestId) {
  return `INSERT INTO audit_events
    (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json)
    VALUES (${q(id)},'tenant-http-a','operator',${q(actor)},${q(action)},${q(entityType)},
      ${q(entityId)},strftime('%Y-%m-%dT%H:%M:%fZ','now'),${q(requestId)},'{}')`;
}

const evidenceId = "source-evidence:ci-http-grant";
const evidenceDigest = "4318c92710ae19a064071f683dd4dd1fabbb1c67be0cce234302fbf8690a63b5";
const rightsId = "source-rights:ci-http-grant";
const rightsDigest = "b".repeat(64);
const reviewer = "ci-measurement-reviewer";
const sourceId = "source-http-grant";

for (const [kind, rowid] of [["backdated", 0], ["forward-injected", 999]]) {
  const requestId = "req-ci-rowid-evidence-" + kind;
  execute("audit attempted evidence revocation " + kind, [
    audit("audit-ci-rowid-evidence-" + kind, reviewer, "source_evidence.revoked",
      "source_evidence_document", evidenceId, requestId),
  ]);
  execute("reject " + kind + " evidence lifecycle rowid", [
    `INSERT INTO source_evidence_events
      (rowid,id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,
       reviewed_sha256,reason,request_id)
      VALUES (${rowid},${q("event-ci-rowid-evidence-" + kind)},${q(evidenceId)},
       'tenant-http-a','site-http-a',${q(sourceId)},${q(reviewer)},'revoked',
       ${q(evidenceDigest)},'CI rowid ordering regression',${q(requestId)})`,
  ], "source evidence event rowid must be monotonic");
}

for (const [kind, rowid] of [["backdated", 0], ["forward-injected", 999]]) {
  const requestId = "req-ci-rowid-rights-" + kind;
  execute("audit attempted rights revocation " + kind, [
    audit("audit-ci-rowid-rights-" + kind, reviewer, "source_data_rights.revoked",
      "source_data_rights_declaration", rightsId, requestId),
  ]);
  execute("reject " + kind + " rights lifecycle rowid", [
    `INSERT INTO source_data_rights_events
      (rowid,id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,
       reviewed_declaration_sha256,reviewed_evidence_sha256,reason,request_id)
      VALUES (${rowid},${q("event-ci-rowid-rights-" + kind)},${q(rightsId)},
       'tenant-http-a','site-http-a',${q(sourceId)},${q(reviewer)},'revoked',
       ${q(rightsDigest)},${q(evidenceDigest)},'CI rowid ordering regression',${q(requestId)})`,
  ], "source data rights event rowid must be monotonic");
}

const evidenceCheck = execute("confirm rejected evidence rowid writes left verification current", [
  `SELECT CASE WHEN COUNT(*)=0 THEN 'ok' ELSE 'bad' END AS result
   FROM source_evidence_events WHERE evidence_id=${q(evidenceId)} AND event_type='revoked'`,
]);
assert.match(evidenceCheck, /ok/, "rejected evidence rowid inserts must not persist");
const rightsCheck = execute("confirm rejected rights rowid writes left approval current", [
  `SELECT CASE WHEN COUNT(*)=0 THEN 'ok' ELSE 'bad' END AS result
   FROM source_data_rights_events WHERE declaration_id=${q(rightsId)} AND event_type='revoked'`,
]);
assert.match(rightsCheck, /ok/, "rejected rights rowid inserts must not persist");

console.log("Source evidence and rights lifecycle rowid ordering tests passed");
