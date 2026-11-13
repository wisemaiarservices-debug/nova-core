import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  registerLaboratoryReportEvidence,
  readLaboratoryReportEvidence,
} from "../src/laboratory-report-evidence.mjs";

globalThis.crypto ??= webcrypto;
const bytes = new TextEncoder().encode("%PDF-1.4\nNOVA laboratory report fixture\n%%EOF");
const base64 = Buffer.from(bytes).toString("base64");
const body = {
  site_id: "site-a", file_name: "lab-report-001.pdf", media_type: "application/pdf",
  laboratory_name: "Declared laboratory", report_number: "REPORT-001",
  sample_reference: "sample-001", issued_at: "2026-10-01T10:30:00Z",
  document_base64: base64,
};

function database() {
  const state = { evidence: null, events: [], batches: 0, statements: [] };
  const db = {
    state,
    prepare(sql) {
      return {
        sql, values: [],
        bind(...values) { this.values = values; state.statements.push({ sql, values }); return this; },
        async all() {
          if (sql.includes("SELECT id FROM sites")) return { results: [{ id: "site-a" }] };
          if (sql.includes("SELECT id, sha256, byte_length FROM laboratory_report_evidence")) {
            return { results: state.evidence ? [{ id: state.evidence.id, sha256: state.evidence.sha256,
              byte_length: state.evidence.byte_length }] : [] };
          }
          if (sql.includes("FROM laboratory_report_evidence e")) {
            return { results: state.evidence ? [state.evidence] : [] };
          }
          throw new Error("unexpected query: " + sql);
        },
      };
    },
    async batch(statements) {
      state.batches += 1;
      assert.equal(statements.length, 2);
      const [insert, event] = statements;
      assert.match(insert.sql, /INSERT(?: OR IGNORE)? INTO laboratory_report_evidence/);
      assert.match(event.sql, /INSERT INTO laboratory_report_evidence_events/);
      if (state.evidence) return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }];
      const v = insert.values;
      state.evidence = {
        id: v[0], tenant_id: v[1], site_id: v[2], evidence_type: "laboratory_report",
        file_name: v[3], media_type: "application/pdf", byte_length: v[4],
        sha256: v[5], document_bytes: v[6], laboratory_name: v[7],
        report_number: v[8], sample_reference: v[9], issued_at: v[10],
        verification_status: "registered_unverified", uploaded_by_subject: v[11],
        created_at: "2026-11-13T12:00:00.000Z",
      };
      state.events.push({ id: event.values[0], evidence_id: event.values[1],
        tenant_id: event.values[2], site_id: event.values[3],
        event_type: "registered", actor_subject: event.values[4] });
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    },
  };
  return db;
}

test("stores exact PDF bytes and a server-computed SHA-256 with append-only registration", async () => {
  const db = database();
  const result = await registerLaboratoryReportEvidence(db, "tenant-a", "owner@example.test",
    "request-1", body);
  const expected = await crypto.subtle.digest("SHA-256", bytes);
  const expectedHex = Array.from(new Uint8Array(expected), b => b.toString(16).padStart(2, "0")).join("");
  assert.equal(result.status, 201);
  assert.equal(result.data.sha256, expectedHex);
  assert.equal(result.data.byte_length, bytes.byteLength);
  assert.equal(result.data.verification_status, "registered_unverified");
  assert.equal(db.state.evidence.uploaded_by_subject, "owner@example.test");
  assert.deepEqual(db.state.evidence.document_bytes, bytes);
  assert.equal(db.state.events.length, 1);
});

test("same site and same bytes are idempotent and do not duplicate history", async () => {
  const db = database();
  const first = await registerLaboratoryReportEvidence(db, "tenant-a", "owner@example.test", "request-1", body);
  const second = await registerLaboratoryReportEvidence(db, "tenant-a", "owner@example.test", "request-2", body);
  assert.equal(first.data.id, second.data.id);
  assert.equal(second.data.idempotent, true);
  assert.equal(db.state.events.length, 1);
});

test("retrieves the persisted bytes only after recomputing and matching the stored digest", async () => {
  const db = database();
  const created = await registerLaboratoryReportEvidence(db, "tenant-a", "owner@example.test", "request-1", body);
  const result = await readLaboratoryReportEvidence(db, "tenant-a", "reader@example.test", "site-a", created.data.id);
  assert.equal(result.evidence_ref, "lab-report:" + created.data.id);
  assert.equal(Buffer.from(result.document_base64, "base64").toString(), Buffer.from(bytes).toString());
  db.state.evidence.document_bytes = new TextEncoder().encode("%PDF-tampered");
  await assert.rejects(() => readLaboratoryReportEvidence(db, "tenant-a", "reader@example.test", "site-a", created.data.id),
    /laboratory_report_persisted_digest_mismatch/);
});

test("rejects malformed payloads, non-PDF bytes, unsafe filenames and invalid dates", async () => {
  const invalid = [
    { ...body, file_name: "../report.pdf" },
    { ...body, media_type: "application/octet-stream" },
    { ...body, document_base64: Buffer.from("not a pdf").toString("base64") },
    { ...body, document_base64: "!!!!" },
    { ...body, issued_at: "2026-99-99" },
    { ...body, issued_at: "2026-02-30" },
    { ...body, extra: "untrusted" },
  ];
  for (const item of invalid) {
    const db = database();
    const result = await registerLaboratoryReportEvidence(db, "tenant-a", "owner@example.test", "request-1", item);
    assert.equal(result.status, 400);
    assert.equal(db.state.batches, 0);
  }
});

test("rejects an unknown site without persisting evidence", async () => {
  const db = database();
  db.prepare = sql => ({ bind() { return this; }, async all() {
    return sql.includes("SELECT id FROM sites") ? { results: [] } : { results: [] };
  } });
  const result = await registerLaboratoryReportEvidence(db, "tenant-a", "owner@example.test", "request-1", body);
  assert.equal(result.error, "site_not_found");
});
