import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import {
  recordSourceEvidenceEvent,
  recordSourceDataRightsEvent,
} from "../src/source-evidence-rights-lifecycle.mjs";

const common = {
  principalSubject: "reviewer-subject",
  tenantId: "tenant-test", siteId: "site-test",
  idempotencyKey: "review-key", requestId: "request-test",
  cryptoProvider: { subtle: webcrypto.subtle, randomUUID },
};
function fixtureDb(kind, overrides = {}) {
  const state = {
    ledger: null, batches: 0, eventType: null,
    evidence: {
      id: "source-evidence:doc-test", tenant_id: common.tenantId,
      site_id: common.siteId, source_id: "source-test", sha256: "a".repeat(64),
      uploaded_by_subject: "uploader-subject", registered_by_subject: "registrar-subject",
      current_state: "registered",
    },
    rights: {
      id: "source-rights:declaration-test", tenant_id: common.tenantId,
      site_id: common.siteId, source_id: "source-test",
      declaration_sha256: "b".repeat(64), supporting_evidence_sha256: "a".repeat(64),
      declared_by_subject: "declarant-subject", uploaded_by_subject: "uploader-subject",
      registered_by_subject: "registrar-subject", current_state: "declared",
      evidence_state: "verified",
    },
    ...overrides,
  };
  const db = {
    prepare(sql) {
      const statement = { sql, args: [], bind(...args) { this.args = args; return this; } };
      statement.all = async () => {
        if (sql.includes("FROM tenant_memberships")) return { results: [{
          membership_status: "active", tenant_status: "active", site_status: "active",
        }] };
        if (sql.includes("FROM tenant_resource_grants")) return { results: [{ allowed: 1 }] };
        if (sql.includes("FROM tenant_source_reviewers")) return { results: [{ allowed: 1 }] };
        if (sql.includes("FROM source_evidence_documents d JOIN sources")) return { results: [state.evidence] };
        if (sql.includes("FROM source_data_rights_declarations d")) return { results: [state.rights] };
        if (sql.includes("FROM source_evidence_event_requests") ||
            sql.includes("FROM source_data_rights_event_requests")) {
          return { results: state.ledger ? [state.ledger] : [] };
        }
        throw new Error("unexpected_query:" + sql);
      };
      return statement;
    },
    async batch(statements) {
      state.batches += 1;
      assert.equal(statements.length, 3);
      const ledger = statements[2].args;
      state.ledger = {
        request_sha256: ledger[7], event_id: ledger[8],
        request_id: ledger[10], response_json: ledger[11],
      };
      state.eventType = ledger[9];
      if (kind === "evidence") state.evidence.current_state = ledger[9];
      else state.rights.current_state = ledger[9];
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return { db, state };
}

test("evidence verification is independently reviewed and atomically audited", async () => {
  const { db, state } = fixtureDb("evidence");
  const result = await recordSourceEvidenceEvent({
    ...common, db, evidenceId: "source-evidence:doc-test", eventType: "verified",
  });
  assert.equal(result.status, "verified");
  assert.equal(result.replayed, false);
  assert.equal(state.batches, 1);
});

test("evidence event exact retry replays without a second write", async () => {
  const { db, state } = fixtureDb("evidence");
  const args = { ...common, db, evidenceId: "source-evidence:doc-test", eventType: "verified" };
  const first = await recordSourceEvidenceEvent(args);
  const second = await recordSourceEvidenceEvent(args);
  assert.equal(second.replayed, true);
  assert.equal(second.event_id, first.event_id);
  assert.equal(state.batches, 1);
});

test("evidence uploader and source registrar cannot independently verify their own evidence", async () => {
  for (const principalSubject of ["uploader-subject", "registrar-subject"]) {
    const { db, state } = fixtureDb("evidence");
    await assert.rejects(recordSourceEvidenceEvent({
      ...common, principalSubject, db, evidenceId: "source-evidence:doc-test", eventType: "verified",
    }), /source_evidence_independent_review_required/);
    assert.equal(state.batches, 0);
  }
});

test("evidence revocation requires a previously verified record and a reason", async () => {
  const { db } = fixtureDb("evidence", { evidence: {
    id: "source-evidence:doc-test", tenant_id: common.tenantId, site_id: common.siteId,
    source_id: "source-test", sha256: "a".repeat(64), uploaded_by_subject: "uploader-subject",
    registered_by_subject: "registrar-subject", current_state: "rejected",
  } });
  await assert.rejects(recordSourceEvidenceEvent({
    ...common, db, evidenceId: "source-evidence:doc-test", eventType: "revoked", reason: "withdrawn",
  }), /source_evidence_lifecycle_conflict/);
  await assert.rejects(recordSourceEvidenceEvent({
    ...common, db, evidenceId: "source-evidence:doc-test", eventType: "rejected",
  }), /source_evidence_event_request_invalid/);
});

test("rights approval is independently reviewed against exact declaration and evidence digests", async () => {
  const { db, state } = fixtureDb("rights");
  const result = await recordSourceDataRightsEvent({
    ...common, db, declarationId: "source-rights:declaration-test", eventType: "approved",
  });
  assert.equal(result.status, "approved");
  assert.equal(result.replayed, false);
  assert.equal(state.batches, 1);
});

test("rights event exact retry replays without a second write", async () => {
  const { db, state } = fixtureDb("rights");
  const args = { ...common, db, declarationId: "source-rights:declaration-test", eventType: "approved" };
  const first = await recordSourceDataRightsEvent(args);
  const second = await recordSourceDataRightsEvent(args);
  assert.equal(second.replayed, true);
  assert.equal(second.event_id, first.event_id);
  assert.equal(state.batches, 1);
});

test("rights declarant, evidence uploader and source registrar cannot approve their own declaration", async () => {
  for (const principalSubject of ["declarant-subject", "uploader-subject", "registrar-subject"]) {
    const { db, state } = fixtureDb("rights");
    await assert.rejects(recordSourceDataRightsEvent({
      ...common, principalSubject, db,
      declarationId: "source-rights:declaration-test", eventType: "approved",
    }), /source_rights_independent_review_required/);
    assert.equal(state.batches, 0);
  }
});

test("rights approval is blocked when supporting evidence is no longer verified", async () => {
  const { db, state } = fixtureDb("rights", { rights: {
    id: "source-rights:declaration-test", tenant_id: common.tenantId, site_id: common.siteId,
    source_id: "source-test", declaration_sha256: "b".repeat(64),
    supporting_evidence_sha256: "a".repeat(64), declared_by_subject: "declarant-subject",
    uploaded_by_subject: "uploader-subject", registered_by_subject: "registrar-subject",
    current_state: "declared", evidence_state: "revoked",
  } });
  await assert.rejects(recordSourceDataRightsEvent({
    ...common, db, declarationId: "source-rights:declaration-test", eventType: "approved",
  }), /source_rights_supporting_evidence_unverified/);
  assert.equal(state.batches, 0);
});

test("rights revocation requires approved status and a reason", async () => {
  const { db } = fixtureDb("rights");
  await assert.rejects(recordSourceDataRightsEvent({
    ...common, db, declarationId: "source-rights:declaration-test",
    eventType: "revoked", reason: "permission withdrawn",
  }), /source_rights_lifecycle_conflict/);
  await assert.rejects(recordSourceDataRightsEvent({
    ...common, db, declarationId: "source-rights:declaration-test", eventType: "rejected",
  }), /source_rights_event_request_invalid/);
});
