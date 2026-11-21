import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
import worker from "../src/index.mjs";

const SECRET = "test-only-internal-secret-with-32-bytes-minimum";
const ISSUER = "https://example.cloudflareaccess.com";
const SUBJECT = "reviewer@example.test";
const TENANT = "tenant-a";
const SITE = "site-a";
const EVIDENCE = "source-evidence:document-a";
const RIGHTS = "source-rights:declaration-a";

class RouteDB {
  constructor({ assigned = true } = {}) {
    this.assigned = assigned;
    this.nonces = new Set();
    this.calls = [];
    this.batches = [];
    this.ledger = new Map();
    this.evidence = {
      id: EVIDENCE, tenant_id: TENANT, site_id: SITE, source_id: "source-a",
      sha256: "a".repeat(64), uploaded_by_subject: "uploader@example.test",
      registered_by_subject: "registrar@example.test", current_state: "registered",
    };
    this.rights = {
      id: RIGHTS, tenant_id: TENANT, site_id: SITE, source_id: "source-a",
      declaration_sha256: "b".repeat(64), supporting_evidence_sha256: "a".repeat(64),
      declared_by_subject: "declarant@example.test", uploaded_by_subject: "uploader@example.test",
      registered_by_subject: "registrar@example.test", current_state: "declared",
      evidence_state: "verified",
    };
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          sql, args,
          async all() {
            db.calls.push({ sql, args });
            if (sql.includes("FROM tenant_memberships m JOIN tenants t")) {
              if (sql.includes("JOIN sites s ON s.id=?")) return { results: [{
                membership_status: "active", tenant_status: "active", site_status: "active",
              }] };
              return { results: [{
                subject: SUBJECT, tenant_id: TENANT, role: "viewer",
                membership_status: "active", tenant_status: "active",
              }] };
            }
            if (sql.includes("FROM tenant_resource_grants")) {
              if (sql.includes("SELECT 1 AS allowed")) return { results: [{ allowed: 1 }] };
              return { results: [{
                subject: SUBJECT, tenant_id: TENANT, resource_type: "site",
                resource_id: SITE, action: "read",
              }] };
            }
            if (sql.includes("FROM tenant_source_reviewers")) {
              return { results: db.assigned ? [{ allowed: 1 }] : [] };
            }
            if (sql.includes("FROM source_evidence_documents d JOIN sources")) {
              return { results: db.evidence ? [db.evidence] : [] };
            }
            if (sql.includes("FROM source_data_rights_declarations d")) {
              return { results: db.rights ? [db.rights] : [] };
            }
            if (sql.includes("FROM source_evidence_event_requests")) {
              const row = db.ledger.get("evidence");
              return { results: row ? [row] : [] };
            }
            if (sql.includes("FROM source_data_rights_event_requests")) {
              const row = db.ledger.get("rights");
              return { results: row ? [row] : [] };
            }
            throw new Error("unexpected SQL: " + sql);
          },
          async run() {
            db.calls.push({ sql, args });
            if (sql.includes("INSERT INTO internal_request_nonces")) {
              if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
              db.nonces.add(args[0]);
              return { meta: { changes: 1 } };
            }
            throw new Error("unexpected write SQL: " + sql);
          },
        };
      },
    };
  }
  async batch(statements) {
    this.batches.push(statements);
    assert.equal(statements.length, 3);
    for (const statement of statements) {
      assert.equal((statement.sql.match(/\?/g) || []).length, statement.args.length);
    }
    const eventSql = statements[1].sql;
    const ledgerArgs = statements[2].args;
    const kind = eventSql.includes("source_evidence_events") ? "evidence" : "rights";
    const row = {
      request_sha256: ledgerArgs[7], event_id: ledgerArgs[8],
      request_id: ledgerArgs[10], response_json: ledgerArgs[11],
    };
    this.ledger.set(kind, row);
    if (kind === "evidence") this.evidence.current_state = ledgerArgs[9];
    else this.rights.current_state = ledgerArgs[9];
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

async function signedRequest(path, body, requestId, idempotencyKey = "governance-key") {
  const method = "POST";
  const bodyText = JSON.stringify(body);
  const headers = new Headers({
    "content-type": "application/json",
    "x-nova-verified-subject": SUBJECT,
    "x-nova-verified-issuer": ISSUER,
    "x-nova-verified-audience": "aud",
    "x-nova-gateway-issued-at": String(Math.floor(Date.now() / 1000)),
    "x-nova-request-id": requestId,
    "x-nova-idempotency-key": idempotencyKey,
    "x-nova-body-sha256": createHash("sha256").update(bodyText).digest("hex"),
  });
  const canonical = JSON.stringify([method, path, SUBJECT, ISSUER, "aud",
    headers.get("x-nova-gateway-issued-at"), requestId,
    headers.get("x-nova-body-sha256"), null, idempotencyKey]);
  headers.set("x-nova-internal-signature",
    createHmac("sha256", SECRET).update(canonical).digest("hex"));
  return new Request("https://private.internal" + path, { method, headers, body: bodyText });
}
function env(db) {
  return {
    ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: SECRET, DB: db,
  };
}
const evidencePath = action =>
  `/internal/v1/tenants/${TENANT}/sites/${SITE}/source-evidence/${EVIDENCE}/${action}`;
const rightsPath = action =>
  `/internal/v1/tenants/${TENANT}/sites/${SITE}/source-data-rights/${RIGHTS}/${action}`;

test("evidence verification route records and exactly replays an independent review", async () => {
  const db = new RouteDB();
  const first = await worker.fetch(await signedRequest(evidencePath("verify"), {}, "request-evidence-1"), env(db));
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.data.status, "verified");
  assert.equal(firstBody.replayed, false);
  const second = await worker.fetch(await signedRequest(evidencePath("verify"), {}, "request-evidence-2"), env(db));
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.replayed, true);
  assert.equal(secondBody.data.event_id, firstBody.data.event_id);
  assert.equal(db.batches.length, 1);
});

test("rights approval route records exact declaration and evidence review", async () => {
  const db = new RouteDB();
  const response = await worker.fetch(await signedRequest(rightsPath("approve"), {}, "request-rights-1"), env(db));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.status, "approved");
  assert.equal(body.replayed, false);
  assert.equal(db.batches.length, 1);
});

test("rejection and revocation routes require a bounded reason", async () => {
  for (const [path, expected] of [
    [evidencePath("reject"), "source_evidence_event_request_invalid"],
    [rightsPath("revoke"), "source_rights_event_request_invalid"],
  ]) {
    const db = new RouteDB();
    const response = await worker.fetch(await signedRequest(path, {}, "request-invalid-" + path), env(db));
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, expected);
    assert.equal(db.batches.length, 0);
  }
});

test("evidence review route denies a subject without an active reviewer assignment", async () => {
  const db = new RouteDB({ assigned: false });
  const response = await worker.fetch(await signedRequest(evidencePath("verify"), {}, "request-unassigned"), env(db));
  assert.equal(response.status, 404);
  assert.equal(db.batches.length, 0);
});

test("evidence and rights lifecycle routes require exact idempotency keys", async () => {
  const db = new RouteDB();
  const response = await worker.fetch(await signedRequest(evidencePath("verify"), {}, "request-no-key", null), env(db));
  assert.equal(response.status, 400);
  assert.equal(db.batches.length, 0);
});
