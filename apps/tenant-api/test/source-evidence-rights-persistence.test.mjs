import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import {
  createSourceEvidenceDocument,
  createSourceDataRightsDeclaration,
} from "../src/source-evidence-rights-persistence.mjs";

const pdf = () => new TextEncoder().encode("%PDF-1.7");
const evidenceDraft = () => ({
  document_type: "data_license", file_name: "license.pdf", media_type: "application/pdf",
  issuer_name: "Provider", document_reference: "LIC-TEST-1",
  issued_at: "2026-01-01T00:00:00Z", effective_from: "2026-01-01T00:00:00Z",
  effective_to: "2027-01-01T00:00:00Z", document_bytes: pdf(),
});
const rightsDraft = () => ({
  asset_id: null, supporting_evidence_id: "source-evidence:verified-fixture",
  provider_name: "Provider", controller_name: "Tenant controller", basis_type: "license",
  instrument_reference: "LIC-TEST-1", permitted_purposes: ["measurement_ingestion", "analytics"],
  restrictions: [], effective_from: "2026-01-01T00:00:00Z",
  effective_to: "2027-01-01T00:00:00Z",
});
const common = {
  principalSubject: "https://issuer.example|opaque-subject:123",
  tenantId: "tenant-unit-test", siteId: "site-unit-test", sourceId: "source-unit-test",
  idempotencyKey: "unit-test-key", requestId: "unit-test-request",
  cryptoProvider: { subtle: webcrypto.subtle, randomUUID },
};

function fixtureDb(kind) {
  const state = { request: null, batches: 0, statements: [] };
  const db = {
    prepare(sql) {
      return {
        sql, args: [],
        bind(...args) {
          this.args = args;
          state.statements.push({ sql, args });
          return this;
        },
        async all() {
          if (sql.includes("FROM tenant_memberships")) return { results: [{
            role: "tenant_owner", membership_status: "active",
            tenant_status: "active", site_status: "active",
          }] };
          if (sql.includes("FROM tenant_resource_grants")) return { results: [{ allowed: 1 }] };
          if (sql.includes("FROM sources")) return { results: [{
            id: common.sourceId, tenant_id: common.tenantId, site_id: common.siteId,
            verification_status: "verified", registered_by_subject: "source-registrar",
          }] };
          if (sql.includes("FROM source_evidence_documents d JOIN source_evidence_events")) {
            return { results: [{ sha256: "a".repeat(64) }] };
          }
          if (sql.includes("FROM source_evidence_document_requests") ||
              sql.includes("FROM source_data_rights_declaration_requests")) {
            return { results: state.request ? [state.request] : [] };
          }
          throw new Error("unexpected_query:" + sql);
        },
      };
    },
    async batch(statements) {
      state.batches += 1;
      assert.equal(statements.length, 4);
      for (const statement of statements) {
        assert.equal((statement.sql.match(/\\?/g) || []).length, statement.args.length,
          "SQL placeholder count must match bound arguments");
      }
      const args = statements[3].args;
      state.request = {
        request_sha256: args[6],
        request_id: args[8],
        response_json: args[9],
      };
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return { db, state };
}

test("evidence registration hashes actual PDF bytes and atomically records audit, event and ledger", async () => {
  const { db, state } = fixtureDb("evidence");
  const result = await createSourceEvidenceDocument({ ...common, db, draft: evidenceDraft() });
  assert.equal(result.replayed, false);
  assert.match(result.evidence_id, /^source-evidence:/);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.status, "registered_unverified");
  assert.equal(state.batches, 1);
  assert.equal(state.statements.length, 4);
});

test("evidence registration exact retry replays without a second write", async () => {
  const { db, state } = fixtureDb("evidence");
  const first = await createSourceEvidenceDocument({ ...common, db, draft: evidenceDraft() });
  const second = await createSourceEvidenceDocument({ ...common, db, draft: evidenceDraft() });
  assert.equal(second.replayed, true);
  assert.equal(second.evidence_id, first.evidence_id);
  assert.equal(state.batches, 1);
});

test("rights declaration requires verified scoped evidence and records explicit purposes", async () => {
  const { db, state } = fixtureDb("rights");
  const result = await createSourceDataRightsDeclaration({ ...common, db, draft: rightsDraft() });
  assert.equal(result.replayed, false);
  assert.match(result.declaration_id, /^source-rights:/);
  assert.deepEqual(result.permitted_purposes, ["analytics", "measurement_ingestion"]);
  assert.equal(result.status, "declared_pending");
  assert.equal(state.batches, 1);
  assert.equal(state.statements.length, 4);
});

test("rights declaration exact retry replays without a second write", async () => {
  const { db, state } = fixtureDb("rights");
  const first = await createSourceDataRightsDeclaration({ ...common, db, draft: rightsDraft() });
  const second = await createSourceDataRightsDeclaration({ ...common, db, draft: rightsDraft() });
  assert.equal(second.replayed, true);
  assert.equal(second.declaration_id, first.declaration_id);
  assert.equal(state.batches, 1);
});

test("rights declaration cannot claim caller-supplied evidence digest or tenant scope", async () => {
  const { db, state } = fixtureDb("rights");
  const invalid = { ...rightsDraft(), tenant_id: "tenant-attacker", evidence_sha256: "f".repeat(64) };
  await assert.rejects(
    createSourceDataRightsDeclaration({ ...common, db, draft: invalid }),
    /source_rights_draft_invalid/,
  );
  assert.equal(state.batches, 0);
});
