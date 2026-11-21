import {
  prepareSourceEvidenceDocument,
  prepareSourceDataRightsDeclaration,
} from "./source-evidence-rights-contract.mjs";
import { canonicalizeConfiguration, sha256Hex, equalDigest } from "./configuration-write-contract.mjs";

function validId(value, max = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function validSubject(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
async function rows(statement) {
  const result = await statement.all();
  if (!result || !Array.isArray(result.results)) throw new Error("source_evidence_storage_invalid_result");
  return result.results;
}
async function one(statement) {
  const result = await rows(statement);
  return result.length === 1 ? result[0] : null;
}
function assertBatch(results, count, code) {
  if (!Array.isArray(results) || results.length !== count ||
      results.some(result => !result || result.success === false ||
        !result.meta || result.meta.changes !== 1)) throw new Error(code);
}
function decodeReplay(prior, digest, conflictCode, corruptCode) {
  if (!prior) return null;
  if (!equalDigest(prior.request_sha256, digest)) throw new Error(conflictCode);
  if (typeof prior.response_json !== "string") throw new Error(corruptCode);
  try { return Object.freeze({ replayed: true, ...JSON.parse(prior.response_json) }); }
  catch { throw new Error(corruptCode); }
}
function requireDb(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new Error("source_evidence_storage_unavailable");
  }
}
async function requireWriteAuthority(db, tenantId, siteId, sourceId, actor) {
  const membership = await rows(db.prepare(
    "SELECT m.role,m.status AS membership_status,t.status AS tenant_status,s.status AS site_status " +
    "FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id " +
    "JOIN sites s ON s.tenant_id=t.id AND s.id=? " +
    "WHERE m.tenant_id=? AND m.subject=? LIMIT 2"
  ).bind(siteId, tenantId, actor));
  if (membership.length !== 1 || membership[0].membership_status !== "active" ||
      membership[0].tenant_status !== "active" || membership[0].site_status !== "active" ||
      !["tenant_owner", "tenant_admin"].includes(membership[0].role)) {
    throw new Error("source_evidence_authorization_denied");
  }
  const grants = await rows(db.prepare(
    "SELECT 1 AS allowed FROM tenant_resource_grants WHERE tenant_id=? AND subject=? " +
    "AND resource_type='site' AND resource_id=? AND action='read' LIMIT 2"
  ).bind(tenantId, actor, siteId));
  if (grants.length !== 1) throw new Error("source_evidence_authorization_denied");
  const sources = await rows(db.prepare(
    "SELECT id,tenant_id,site_id,verification_status,registered_by_subject FROM sources " +
    "WHERE id=? AND tenant_id=? AND site_id=? LIMIT 2"
  ).bind(sourceId, tenantId, siteId));
  if (sources.length !== 1 || sources[0].verification_status !== "verified") {
    throw new Error("source_evidence_source_not_verified");
  }
  return sources[0];
}
async function readRequest(db, table, scopeSql, scopeValues) {
  return one(db.prepare(`SELECT request_sha256,request_id,response_json FROM ${table} WHERE ${scopeSql} LIMIT 2`).bind(...scopeValues));
}

/** Atomically register immutable PDF bytes, audit and initial lifecycle event. */
export async function createSourceEvidenceDocument({
  db, principalSubject, tenantId, siteId, sourceId, idempotencyKey, requestId,
  draft, cryptoProvider = globalThis.crypto,
}) {
  requireDb(db);
  if (!validId(tenantId, 120) || !validId(siteId) || !validId(sourceId) ||
      !validSubject(principalSubject) || !validId(idempotencyKey) || !validId(requestId)) {
    throw new Error("source_evidence_request_invalid");
  }
  await requireWriteAuthority(db, tenantId, siteId, sourceId, principalSubject);
  const prepared = await prepareSourceEvidenceDocument({ draft, cryptoProvider });
  const canonical = canonicalizeConfiguration({
    tenant_id: tenantId, site_id: siteId, source_id: sourceId,
    actor_subject: principalSubject,
    document: {
      document_type: prepared.document_type, file_name: prepared.file_name,
      media_type: prepared.media_type, issuer_name: prepared.issuer_name,
      document_reference: prepared.document_reference, issued_at: prepared.issued_at,
      effective_from: prepared.effective_from, effective_to: prepared.effective_to,
      byte_length: prepared.byte_length, sha256: prepared.sha256,
    },
  });
  const digest = await sha256Hex(canonical.canonicalJson, cryptoProvider);
  const scope = "tenant_id=? AND site_id=? AND source_id=? AND actor_subject=? AND idempotency_key=?";
  const scopeValues = [tenantId, siteId, sourceId, principalSubject, idempotencyKey];
  const prior = await readRequest(db, "source_evidence_document_requests", scope, scopeValues);
  const replay = decodeReplay(prior, digest, "source_evidence_idempotency_conflict", "source_evidence_idempotency_corrupt");
  if (replay) return replay;

  const evidenceId = `source-evidence:${cryptoProvider.randomUUID()}`;
  const eventId = cryptoProvider.randomUUID();
  const ledgerId = cryptoProvider.randomUUID();
  const auditId = cryptoProvider.randomUUID();
  const now = new Date().toISOString();
  const response = {
    evidence_id: evidenceId, tenant_id: tenantId, site_id: siteId, source_id: sourceId,
    sha256: prepared.sha256, byte_length: prepared.byte_length,
    status: "registered_unverified", request_id: requestId, created_at: now,
  };
  const statements = [
    db.prepare("INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json) VALUES (?,?,'operator',?,'source_evidence.registered','source_evidence_document',?,?,?,?)")
      .bind(auditId, tenantId, principalSubject, evidenceId, now, requestId,
        JSON.stringify({ evidence_id: evidenceId, source_id: sourceId, sha256: prepared.sha256, request_sha256: digest })),
    db.prepare("INSERT INTO source_evidence_documents (id,tenant_id,site_id,source_id,document_type,file_name,media_type,byte_length,sha256,document_bytes,issuer_name,document_reference,issued_at,effective_from,effective_to,uploaded_by_subject,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(evidenceId, tenantId, siteId, sourceId, prepared.document_type, prepared.file_name,
        prepared.media_type, prepared.byte_length, prepared.sha256, prepared.document_bytes,
        prepared.issuer_name, prepared.document_reference, prepared.issued_at,
        prepared.effective_from, prepared.effective_to, principalSubject, requestId),
    db.prepare("INSERT INTO source_evidence_events (id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id) VALUES (?,?,?,?,?,?,'registered',?,NULL,?)")
      .bind(eventId, evidenceId, tenantId, siteId, sourceId, principalSubject, prepared.sha256, requestId),
    db.prepare("INSERT INTO source_evidence_document_requests (id,tenant_id,site_id,source_id,actor_subject,idempotency_key,request_sha256,evidence_id,request_id,response_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(ledgerId, tenantId, siteId, sourceId, principalSubject, idempotencyKey, digest, evidenceId, requestId, JSON.stringify(response)),
  ];
  try {
    assertBatch(await db.batch(statements), 4, "source_evidence_atomic_write_failed");
  } catch (error) {
    const raced = await readRequest(db, "source_evidence_document_requests", scope, scopeValues);
    const recovered = decodeReplay(raced, digest, "source_evidence_idempotency_conflict", "source_evidence_idempotency_corrupt");
    if (recovered) return recovered;
    throw error;
  }
  const stored = await readRequest(db, "source_evidence_document_requests", scope, scopeValues);
  const completed = decodeReplay(stored, digest, "source_evidence_idempotency_conflict", "source_evidence_idempotency_corrupt");
  if (!completed) throw new Error("source_evidence_write_result_unavailable");
  return Object.freeze({ replayed: false, ...JSON.parse(stored.response_json) });
}

/** Atomically declare rights against an independently verified evidence digest. */
export async function createSourceDataRightsDeclaration({
  db, principalSubject, tenantId, siteId, sourceId, idempotencyKey, requestId,
  draft, cryptoProvider = globalThis.crypto,
}) {
  requireDb(db);
  if (!validId(tenantId, 120) || !validId(siteId) || !validId(sourceId) ||
      !validSubject(principalSubject) || !validId(idempotencyKey) || !validId(requestId)) {
    throw new Error("source_rights_request_invalid");
  }
  await requireWriteAuthority(db, tenantId, siteId, sourceId, principalSubject);
  if (!draft || typeof draft !== "object" || Array.isArray(draft) ||
      Object.keys(draft).some(key => ![
        "asset_id", "supporting_evidence_id", "provider_name", "controller_name",
        "basis_type", "instrument_reference", "permitted_purposes", "restrictions",
        "effective_from", "effective_to",
      ].includes(key))) throw new Error("source_rights_draft_invalid");
  const evidenceRows = await rows(db.prepare(
    "SELECT d.sha256 FROM source_evidence_documents d JOIN source_evidence_events e " +
    "ON e.evidence_id=d.id AND e.event_type='verified' " +
    "WHERE d.id=? AND d.tenant_id=? AND d.site_id=? AND d.source_id=? " +
    "AND e.id=(SELECT e2.id FROM source_evidence_events e2 WHERE e2.evidence_id=d.id ORDER BY e2.rowid DESC LIMIT 1) LIMIT 2"
  ).bind(draft.supporting_evidence_id, tenantId, siteId, sourceId));
  if (evidenceRows.length !== 1) throw new Error("source_rights_supporting_evidence_unverified");
  const prepared = await prepareSourceDataRightsDeclaration({
    draft, tenantId, siteId, sourceId, principalSubject,
    evidenceSha256: evidenceRows[0].sha256, cryptoProvider,
  });
  const scope = "tenant_id=? AND site_id=? AND source_id=? AND actor_subject=? AND idempotency_key=?";
  const scopeValues = [tenantId, siteId, sourceId, principalSubject, idempotencyKey];
  const prior = await readRequest(db, "source_data_rights_declaration_requests", scope, scopeValues);
  const replay = decodeReplay(prior, prepared.declaration_sha256,
    "source_rights_idempotency_conflict", "source_rights_idempotency_corrupt");
  if (replay) return replay;

  const declarationId = `source-rights:${cryptoProvider.randomUUID()}`;
  const eventId = cryptoProvider.randomUUID();
  const ledgerId = cryptoProvider.randomUUID();
  const auditId = cryptoProvider.randomUUID();
  const now = new Date().toISOString();
  const response = {
    declaration_id: declarationId, tenant_id: tenantId, site_id: siteId, source_id: sourceId,
    supporting_evidence_id: prepared.supporting_evidence_id,
    declaration_sha256: prepared.declaration_sha256, status: "declared_pending",
    permitted_purposes: JSON.parse(prepared.permitted_purposes_json),
    request_id: requestId, created_at: now,
  };
  const statements = [
    db.prepare("INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json) VALUES (?,?,'operator',?,'source_data_rights.declared','source_data_rights_declaration',?,?,?,?)")
      .bind(auditId, tenantId, principalSubject, declarationId, now, requestId,
        JSON.stringify({ declaration_id: declarationId, source_id: sourceId, declaration_sha256: prepared.declaration_sha256 })),
    db.prepare("INSERT INTO source_data_rights_declarations (id,tenant_id,site_id,source_id,asset_id,supporting_evidence_id,supporting_evidence_sha256,provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,restrictions_json,effective_from,effective_to,declaration_sha256,declared_by_subject,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(declarationId, tenantId, siteId, sourceId, prepared.asset_id, prepared.supporting_evidence_id,
        prepared.supporting_evidence_sha256, prepared.provider_name, prepared.controller_name,
        prepared.basis_type, prepared.instrument_reference, prepared.permitted_purposes_json,
        prepared.restrictions_json, prepared.effective_from, prepared.effective_to,
        prepared.declaration_sha256, principalSubject, requestId),
    db.prepare("INSERT INTO source_data_rights_events (id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,reviewed_evidence_sha256,reason,request_id) VALUES (?,?,?,?,?,?,'declared',?,?,NULL,?)")
      .bind(eventId, declarationId, tenantId, siteId, sourceId, principalSubject,
        prepared.declaration_sha256, prepared.supporting_evidence_sha256, requestId),
    db.prepare("INSERT INTO source_data_rights_declaration_requests (id,tenant_id,site_id,source_id,actor_subject,idempotency_key,request_sha256,declaration_id,request_id,response_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(ledgerId, tenantId, siteId, sourceId, principalSubject, idempotencyKey,
        prepared.declaration_sha256, declarationId, requestId, JSON.stringify(response)),
  ];
  try {
    assertBatch(await db.batch(statements), 4, "source_rights_atomic_write_failed");
  } catch (error) {
    const raced = await readRequest(db, "source_data_rights_declaration_requests", scope, scopeValues);
    const recovered = decodeReplay(raced, prepared.declaration_sha256,
      "source_rights_idempotency_conflict", "source_rights_idempotency_corrupt");
    if (recovered) return recovered;
    throw error;
  }
  const stored = await readRequest(db, "source_data_rights_declaration_requests", scope, scopeValues);
  const completed = decodeReplay(stored, prepared.declaration_sha256,
    "source_rights_idempotency_conflict", "source_rights_idempotency_corrupt");
  if (!completed) throw new Error("source_rights_write_result_unavailable");
  return Object.freeze({ replayed: false, ...JSON.parse(stored.response_json) });
}
