import { canonicalizeConfiguration, sha256Hex, equalDigest } from "./configuration-write-contract.mjs";

function validId(value, max = 176) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function validSubject(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function requireDb(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new Error("source_governance_storage_unavailable");
  }
}
async function rows(statement) {
  const result = await statement.all();
  if (!result || !Array.isArray(result.results)) throw new Error("source_governance_storage_invalid_result");
  return result.results;
}
async function one(statement) {
  const result = await rows(statement);
  return result.length === 1 ? result[0] : null;
}
function assertBatch(results, code) {
  if (!Array.isArray(results) || results.length !== 3 ||
      results.some(result => !result || result.success === false ||
        !result.meta || result.meta.changes !== 1)) throw new Error(code);
}
function replayOrConflict(prior, digest, prefix) {
  if (!prior) return null;
  if (!equalDigest(prior.request_sha256, digest)) throw new Error(prefix + "_idempotency_conflict");
  if (typeof prior.response_json !== "string") throw new Error(prefix + "_idempotency_corrupt");
  try { return Object.freeze({ replayed: true, ...JSON.parse(prior.response_json) }); }
  catch { throw new Error(prefix + "_idempotency_corrupt"); }
}
function validateEvent(eventType, reason, allowed, prefix) {
  if (!allowed.has(eventType) ||
      (eventType === "rejected" || eventType === "revoked"
        ? typeof reason !== "string" || reason.length < 1 || reason.length > 2000 ||
          reason.trim() !== reason || /[\\u0000-\\u001f\\u007f]/.test(reason)
        : reason !== null)) throw new Error(prefix + "_event_request_invalid");
}
async function requireReviewer(db, tenantId, siteId, actor, prefix) {
  const memberships = await rows(db.prepare(
    "SELECT m.status AS membership_status,t.status AS tenant_status,s.status AS site_status " +
    "FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id " +
    "JOIN sites s ON s.id=? AND s.tenant_id=m.tenant_id " +
    "WHERE m.tenant_id=? AND m.subject=? LIMIT 2"
  ).bind(siteId, tenantId, actor));
  if (memberships.length !== 1 || memberships[0].membership_status !== "active" ||
      memberships[0].tenant_status !== "active" || memberships[0].site_status !== "active") {
    throw new Error(prefix + "_authorization_denied");
  }
  const grants = await rows(db.prepare(
    "SELECT 1 AS allowed FROM tenant_resource_grants WHERE tenant_id=? AND subject=? " +
    "AND resource_type='site' AND resource_id=? AND action='read' LIMIT 2"
  ).bind(tenantId, actor, siteId));
  const reviewers = await rows(db.prepare(
    "SELECT 1 AS allowed FROM tenant_source_reviewers WHERE tenant_id=? AND site_id=? " +
    "AND reviewer_subject=? AND status='active' LIMIT 2"
  ).bind(tenantId, siteId, actor));
  if (grants.length !== 1 || reviewers.length !== 1) throw new Error(prefix + "_review_denied");
}
async function persistLifecycleEvent({
  db, tenantId, siteId, entityId, sourceId, actor, eventType, reason,
  reviewedDigest, reviewedEvidenceDigest, idempotencyKey, requestId,
  entityKind, prefix, allowedEvents, currentState, eligibleStates,
  excludedSubjects, cryptoProvider,
}) {
  const table = entityKind === "evidence" ? "source_evidence_event_requests" : "source_data_rights_event_requests";
  const eventTable = entityKind === "evidence" ? "source_evidence_events" : "source_data_rights_events";
  const entityColumn = entityKind === "evidence" ? "evidence_id" : "declaration_id";
  const scope = `tenant_id=? AND site_id=? AND ${entityColumn}=? AND actor_subject=? AND idempotency_key=?`;
  const scopeValues = [tenantId, siteId, entityId, actor, idempotencyKey];
  const prior = await one(db.prepare(`SELECT request_sha256,event_id,request_id,response_json FROM ${table} WHERE ${scope} LIMIT 2`).bind(...scopeValues));
  const canonical = canonicalizeConfiguration({
    tenant_id: tenantId, site_id: siteId, entity_id: entityId, source_id: sourceId,
    actor_subject: actor, event_type: eventType, reason,
    reviewed_digest: reviewedDigest, reviewed_evidence_digest: reviewedEvidenceDigest,
  });
  const digest = await sha256Hex(canonical.canonicalJson, cryptoProvider);
  const replay = replayOrConflict(prior, digest, prefix);
  if (replay) return replay;
  if (!eligibleStates.includes(currentState)) throw new Error(prefix + "_lifecycle_conflict");
  if (excludedSubjects.includes(actor)) throw new Error(prefix + "_independent_review_required");

  const eventId = cryptoProvider.randomUUID();
  const ledgerId = cryptoProvider.randomUUID();
  const auditId = cryptoProvider.randomUUID();
  const now = new Date().toISOString();
  const status = eventType === "verified" ? "verified"
    : eventType === "approved" ? "approved"
    : eventType === "rejected" ? "rejected" : "revoked";
  const response = {
    [entityColumn]: entityId, event_id: eventId, event_type: eventType,
    status, actor_subject: actor, request_id: requestId, occurred_at: now,
  };
  const auditAction = (entityKind === "evidence" ? "source_evidence." : "source_data_rights.") + eventType;
  const entityType = entityKind === "evidence" ? "source_evidence_document" : "source_data_rights_declaration";
  const statements = [
    db.prepare(
      "INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json) " +
      "VALUES (?,?,'operator',?,?,?,?,?,?,?)"
    ).bind(auditId, tenantId, actor, auditAction, entityType, entityId, now, requestId,
      JSON.stringify({ [entityColumn]: entityId, source_id: sourceId, event_id: eventId,
        event_type: eventType, reviewed_digest: reviewedDigest,
        reviewed_evidence_digest: reviewedEvidenceDigest, request_sha256: digest })),
    entityKind === "evidence"
      ? db.prepare(
          "INSERT INTO source_evidence_events (id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?)"
        ).bind(eventId, entityId, tenantId, siteId, sourceId, actor, eventType, reviewedDigest, reason, requestId)
      : db.prepare(
          "INSERT INTO source_data_rights_events (id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,reviewed_evidence_sha256,reason,request_id) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?)"
        ).bind(eventId, entityId, tenantId, siteId, sourceId, actor, eventType,
          reviewedDigest, reviewedEvidenceDigest, reason, requestId),
    db.prepare(
      `INSERT INTO ${table} (id,tenant_id,site_id,source_id,${entityColumn},actor_subject,idempotency_key,request_sha256,event_id,event_type,request_id,response_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(ledgerId, tenantId, siteId, sourceId, entityId, actor, idempotencyKey,
      digest, eventId, eventType, requestId, JSON.stringify(response)),
  ];
  try {
    assertBatch(await db.batch(statements), prefix + "_event_atomic_write_failed");
  } catch (error) {
    const raced = await one(db.prepare(`SELECT request_sha256,event_id,request_id,response_json FROM ${table} WHERE ${scope} LIMIT 2`).bind(...scopeValues));
    const recovered = replayOrConflict(raced, digest, prefix);
    if (recovered) return recovered;
    throw error;
  }
  const stored = await one(db.prepare(`SELECT request_sha256,event_id,request_id,response_json FROM ${table} WHERE ${scope} LIMIT 2`).bind(...scopeValues));
  const completed = replayOrConflict(stored, digest, prefix);
  if (!completed) throw new Error(prefix + "_event_write_result_unavailable");
  return Object.freeze({ replayed: false, ...JSON.parse(stored.response_json) });
}

/** Append an independently reviewed evidence verification/rejection/revocation event. */
export async function recordSourceEvidenceEvent({
  db, principalSubject, tenantId, siteId, evidenceId, idempotencyKey, requestId,
  eventType, reason = null, cryptoProvider = globalThis.crypto,
}) {
  requireDb(db);
  if (!validId(tenantId, 120) || !validId(siteId) || !validId(evidenceId) ||
      !validSubject(principalSubject) || !validId(idempotencyKey) || !validId(requestId)) {
    throw new Error("source_evidence_event_request_invalid");
  }
  const prefix = "source_evidence";
  validateEvent(eventType, reason, new Set(["verified", "rejected", "revoked"]), prefix);
  await requireReviewer(db, tenantId, siteId, principalSubject, prefix);
  const entity = await one(db.prepare(
    "SELECT d.id,d.tenant_id,d.site_id,d.source_id,d.sha256,d.uploaded_by_subject," +
    "src.registered_by_subject,(SELECT e.event_type FROM source_evidence_events e " +
    "WHERE e.evidence_id=d.id ORDER BY e.rowid DESC LIMIT 1) AS current_state " +
    "FROM source_evidence_documents d JOIN sources src ON src.id=d.source_id AND src.tenant_id=d.tenant_id " +
    "WHERE d.id=? AND d.tenant_id=? AND d.site_id=? LIMIT 2"
  ).bind(evidenceId, tenantId, siteId));
  if (!entity) throw new Error("source_evidence_not_found");
  const eligible = eventType === "revoked" ? ["verified"] : ["registered"];
  return persistLifecycleEvent({
    db, tenantId, siteId, entityId: evidenceId, sourceId: entity.source_id,
    actor: principalSubject, eventType, reason, reviewedDigest: entity.sha256,
    reviewedEvidenceDigest: entity.sha256, idempotencyKey, requestId,
    entityKind: "evidence", prefix, allowedEvents: new Set(["verified", "rejected", "revoked"]),
    currentState: entity.current_state, eligibleStates: eligible,
    excludedSubjects: [entity.uploaded_by_subject, entity.registered_by_subject].filter(Boolean),
    cryptoProvider,
  });
}

/** Append an independent approval/rejection/revocation event for a rights declaration. */
export async function recordSourceDataRightsEvent({
  db, principalSubject, tenantId, siteId, declarationId, idempotencyKey, requestId,
  eventType, reason = null, cryptoProvider = globalThis.crypto,
}) {
  requireDb(db);
  if (!validId(tenantId, 120) || !validId(siteId) || !validId(declarationId) ||
      !validSubject(principalSubject) || !validId(idempotencyKey) || !validId(requestId)) {
    throw new Error("source_rights_event_request_invalid");
  }
  const prefix = "source_rights";
  validateEvent(eventType, reason, new Set(["approved", "rejected", "revoked"]), prefix);
  await requireReviewer(db, tenantId, siteId, principalSubject, prefix);
  const entity = await one(db.prepare(
    "SELECT d.id,d.tenant_id,d.site_id,d.source_id,d.declaration_sha256," +
    "d.supporting_evidence_sha256,d.declared_by_subject,doc.uploaded_by_subject," +
    "src.registered_by_subject," +
    "(SELECT e.event_type FROM source_data_rights_events e WHERE e.declaration_id=d.id ORDER BY e.rowid DESC LIMIT 1) AS current_state," +
    "(SELECT ee.event_type FROM source_evidence_events ee WHERE ee.evidence_id=doc.id ORDER BY ee.rowid DESC LIMIT 1) AS evidence_state " +
    "FROM source_data_rights_declarations d " +
    "JOIN source_evidence_documents doc ON doc.id=d.supporting_evidence_id AND doc.tenant_id=d.tenant_id " +
    "AND doc.site_id=d.site_id AND doc.source_id=d.source_id AND doc.sha256=d.supporting_evidence_sha256 " +
    "JOIN sources src ON src.id=d.source_id AND src.tenant_id=d.tenant_id " +
    "WHERE d.id=? AND d.tenant_id=? AND d.site_id=? LIMIT 2"
  ).bind(declarationId, tenantId, siteId));
  if (!entity) throw new Error("source_rights_not_found");
  if (entity.evidence_state !== "verified") throw new Error("source_rights_supporting_evidence_unverified");
  const eligible = eventType === "revoked" ? ["approved"] : ["declared"];
  return persistLifecycleEvent({
    db, tenantId, siteId, entityId: declarationId, sourceId: entity.source_id,
    actor: principalSubject, eventType, reason,
    reviewedDigest: entity.declaration_sha256,
    reviewedEvidenceDigest: entity.supporting_evidence_sha256,
    idempotencyKey, requestId, entityKind: "rights", prefix,
    allowedEvents: new Set(["approved", "rejected", "revoked"]),
    currentState: entity.current_state, eligibleStates: eligible,
    excludedSubjects: [entity.declared_by_subject, entity.uploaded_by_subject,
      entity.registered_by_subject].filter(Boolean),
    cryptoProvider,
  });
}
