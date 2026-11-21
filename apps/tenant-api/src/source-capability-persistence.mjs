import { validateSourceCapabilityDraft } from "./source-capability-contract.mjs";
import { canonicalizeConfiguration, sha256Hex, equalDigest } from "./configuration-write-contract.mjs";

const DRAFT_KEYS = new Set([
  "source_id", "asset_id", "module", "metric", "unit", "measurement_kind",
  "quantity_semantics", "acquisition_protocol", "protocol_version", "sampling",
  "timestamp", "quality", "calibration", "data_rights_ref", "evidence_ref", "version",
]);

function validId(value, max = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function validSubject(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function assertBatch(results) {
  if (!Array.isArray(results) || results.length !== 3 ||
      results.some(result => !result || result.success === false ||
        !result.meta || result.meta.changes !== 1)) {
    throw new Error("source_capability_atomic_write_failed");
  }
}
async function rows(statement) {
  const result = await statement.all();
  if (!result || !Array.isArray(result.results)) throw new Error("source_capability_storage_invalid_result");
  return result.results;
}
async function one(statement) {
  const result = await rows(statement);
  return result.length === 1 ? result[0] : null;
}
async function findRequest(db, tenantId, siteId, actor, key) {
  return one(db.prepare(
    "SELECT request_sha256, capability_id, request_id, response_json FROM source_capability_creation_requests " +
    "WHERE tenant_id=? AND site_id=? AND actor_subject=? AND idempotency_key=? LIMIT 2"
  ).bind(tenantId, siteId, actor, key));
}
function replayOrConflict(prior, digest) {
  if (!prior) return null;
  if (!equalDigest(prior.request_sha256, digest)) {
    throw new Error("source_capability_idempotency_conflict");
  }
  if (typeof prior.response_json !== "string") {
    throw new Error("source_capability_idempotency_incomplete");
  }
  let response;
  try { response = JSON.parse(prior.response_json); }
  catch { throw new Error("source_capability_idempotency_corrupt"); }
  return Object.freeze({ replayed: true, ...response });
}

/**
 * Persist one immutable pending source capability version.
 *
 * Tenant/site/actor are server-derived inputs from the authenticated gateway
 * and route resolver. The caller's draft never controls those identities.
 * D1 triggers remain the final authority for lifecycle, scope and calibration.
 */
export async function createSourceCapabilityDraft({
  db, principalSubject, tenantId, siteId, idempotencyKey, requestId, draft,
  cryptoProvider = globalThis.crypto,
}) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new Error("source_capability_storage_unavailable");
  }
  if (!validId(tenantId, 120) || !validId(siteId) || !validSubject(principalSubject) ||
      !validId(idempotencyKey) || !validId(requestId)) {
    throw new Error("source_capability_request_invalid");
  }
  if (!draft || typeof draft !== "object" || Array.isArray(draft) ||
      Object.keys(draft).some(key => !DRAFT_KEYS.has(key)) ||
      !Object.hasOwn(draft, "source_id")) {
    throw new Error("source_capability_draft_invalid");
  }

  const membership = await rows(db.prepare(
    "SELECT m.role, m.status AS membership_status, t.status AS tenant_status " +
    "FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id " +
    "JOIN sites s ON s.tenant_id=t.id " +
    "WHERE m.tenant_id=? AND m.subject=? AND s.id=? LIMIT 2"
  ).bind(tenantId, principalSubject, siteId));
  if (membership.length !== 1 || membership[0].membership_status !== "active" ||
      membership[0].tenant_status !== "active" ||
      !["tenant_owner", "tenant_admin"].includes(membership[0].role)) {
    throw new Error("source_capability_authorization_denied");
  }
  const grants = await rows(db.prepare(
    "SELECT 1 AS allowed FROM tenant_resource_grants WHERE tenant_id=? AND subject=? " +
    "AND resource_type='site' AND resource_id=? AND action='read' LIMIT 2"
  ).bind(tenantId, principalSubject, siteId));
  if (grants.length !== 1) throw new Error("source_capability_authorization_denied");

  const sources = await rows(db.prepare(
    "SELECT id, tenant_id, site_id, module, verification_status FROM sources " +
    "WHERE id=? AND tenant_id=? AND site_id=? LIMIT 2"
  ).bind(draft.source_id, tenantId, siteId));
  if (sources.length !== 1 || sources[0].verification_status !== "verified") {
    throw new Error("source_capability_source_not_verified");
  }
  const source = sources[0];
  const normalized = {
    ...draft,
    tenant_id: tenantId,
    site_id: siteId,
    asset_id: draft.asset_id ?? null,
  };
  const validation = validateSourceCapabilityDraft(normalized, source);
  if (!validation.valid) {
    const error = new Error("source_capability_draft_invalid");
    error.details = validation.errors;
    throw error;
  }
  if (normalized.asset_id !== null) {
    const assets = await rows(db.prepare(
      "SELECT id FROM assets WHERE id=? AND tenant_id=? AND site_id=? AND status='active' LIMIT 2"
    ).bind(normalized.asset_id, tenantId, siteId));
    if (assets.length !== 1) throw new Error("source_capability_asset_invalid");
  }

  const canonical = canonicalizeConfiguration({
    tenant_id: tenantId, site_id: siteId, actor_subject: principalSubject,
    draft: normalized,
  });
  const requestSha256 = await sha256Hex(canonical.canonicalJson, cryptoProvider);
  const prior = await findRequest(db, tenantId, siteId, principalSubject, idempotencyKey);
  const replay = replayOrConflict(prior, requestSha256);
  if (replay) return replay;

  const capabilityId = cryptoProvider.randomUUID();
  const requestRecordId = cryptoProvider.randomUUID();
  const auditId = cryptoProvider.randomUUID();
  const now = new Date().toISOString();
  const response = {
    capability_id: capabilityId, tenant_id: tenantId, site_id: siteId,
    source_id: source.id, asset_id: normalized.asset_id,
    module: normalized.module, metric: normalized.metric, unit: normalized.unit,
    version: normalized.version, status: "pending", created_by_subject: principalSubject,
    request_id: requestId, created_at: now,
  };
  const responseJson = JSON.stringify(response);
  const auditDetails = JSON.stringify({
    capability_id: capabilityId, source_id: source.id, asset_id: normalized.asset_id,
    metric: normalized.metric, unit: normalized.unit, version: normalized.version,
    request_sha256: requestSha256,
  });
  const statements = [
    db.prepare(
      "INSERT INTO source_capabilities " +
      "(id,tenant_id,site_id,source_id,asset_id,module,metric,unit,measurement_kind,quantity_semantics," +
      "acquisition_protocol,protocol_version,sampling_mode,interval_seconds,max_age_seconds," +
      "max_future_skew_seconds,timezone,allowed_quality_flags_json,calibration_required," +
      "calibration_profile_ref,data_rights_ref,evidence_ref,version,status,created_by_subject) " +
      "SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',? " +
      "WHERE EXISTS (SELECT 1 FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id " +
      "JOIN sites s ON s.tenant_id=t.id AND s.id=? " +
      "WHERE m.tenant_id=? AND m.subject=? AND m.status='active' AND t.status='active' " +
      "AND s.status='active' AND m.role IN ('tenant_owner','tenant_admin')) " +
      "AND EXISTS (SELECT 1 FROM tenant_resource_grants WHERE tenant_id=? AND subject=? " +
      "AND resource_type='site' AND resource_id=? AND action='read') " +
      "AND EXISTS (SELECT 1 FROM sources WHERE id=? AND tenant_id=? AND site_id=? AND module=? AND verification_status='verified')"
    ).bind(
      capabilityId, tenantId, siteId, source.id, normalized.asset_id, normalized.module,
      normalized.metric, normalized.unit, normalized.measurement_kind, normalized.quantity_semantics,
      normalized.acquisition_protocol, normalized.protocol_version, normalized.sampling.mode,
      normalized.sampling.interval_seconds ?? null, normalized.sampling.max_age_seconds,
      normalized.timestamp.max_future_skew_seconds, normalized.timestamp.timezone,
      JSON.stringify(normalized.quality.allowed_flags), normalized.calibration.required ? 1 : 0,
      normalized.calibration.profile_ref ?? null, normalized.data_rights_ref, normalized.evidence_ref,
      normalized.version, principalSubject, siteId, tenantId, principalSubject,
      tenantId, principalSubject, siteId, source.id, tenantId, siteId, normalized.module
    ),
    db.prepare(
      "INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id," +
      "occurred_at,request_id,details_json) VALUES (?,?,'operator',?,'source_capability.created'," +
      "'source_capability',?,?,?,?)"
    ).bind(auditId, tenantId, principalSubject, capabilityId, now, requestId, auditDetails),
    db.prepare(
      "INSERT INTO source_capability_creation_requests " +
      "(id,tenant_id,site_id,actor_subject,idempotency_key,request_sha256,capability_id,request_id,response_json) " +
      "VALUES (?,?,?,?,?,?,?,?,?)"
    ).bind(requestRecordId, tenantId, siteId, principalSubject, idempotencyKey,
      requestSha256, capabilityId, requestId, responseJson),
  ];
  try {
    assertBatch(await db.batch(statements));
  } catch (error) {
    const raced = await findRequest(db, tenantId, siteId, principalSubject, idempotencyKey);
    const racedReplay = replayOrConflict(raced, requestSha256);
    if (racedReplay) return racedReplay;
    throw error;
  }
  const completed = await findRequest(db, tenantId, siteId, principalSubject, idempotencyKey);
  const result = replayOrConflict(completed, requestSha256);
  if (!result) throw new Error("source_capability_write_result_unavailable");
  return Object.freeze({ replayed: false, ...JSON.parse(completed.response_json) });
}

const CAPABILITY_EVENT_TYPES = new Set(["submitted", "approved", "rejected", "revoked"]);
const EVENT_STATUS = Object.freeze({
  submitted: "pending", approved: "approved", rejected: "rejected", revoked: "revoked",
});

/** Append one governed lifecycle event with exact retry semantics. */
export async function recordSourceCapabilityEvent({
  db, principalSubject, tenantId, siteId, capabilityId, idempotencyKey,
  requestId, eventType, evidenceRef, reason = null,
  cryptoProvider = globalThis.crypto,
}) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new Error("source_capability_storage_unavailable");
  }
  if (!validId(tenantId, 120) || !validId(siteId) || !validId(capabilityId) ||
      !validSubject(principalSubject) || !validId(idempotencyKey) || !validId(requestId) ||
      !CAPABILITY_EVENT_TYPES.has(eventType) || !validId(evidenceRef, 500) ||
      (reason !== null && (typeof reason !== "string" || reason.length < 1 ||
        reason.length > 2000 || reason.trim() !== reason ||
        /[\u0000-\u001f\u007f]/.test(reason))) ||
      ((eventType === "rejected" || eventType === "revoked") && reason === null) ||
      ((eventType === "submitted" || eventType === "approved") && reason !== null)) {
    throw new Error("source_capability_event_request_invalid");
  }

  const membership = await rows(db.prepare(
    "SELECT m.role, m.status AS membership_status, t.status AS tenant_status " +
    "FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id " +
    "JOIN sites s ON s.tenant_id=t.id AND s.id=? " +
    "WHERE m.tenant_id=? AND m.subject=? LIMIT 2"
  ).bind(siteId, tenantId, principalSubject));
  const grant = await rows(db.prepare(
    "SELECT 1 AS allowed FROM tenant_resource_grants WHERE tenant_id=? AND subject=? " +
    "AND resource_type='site' AND resource_id=? AND action='read' LIMIT 2"
  ).bind(tenantId, principalSubject, siteId));
  if (membership.length !== 1 || membership[0].membership_status !== "active" ||
      membership[0].tenant_status !== "active" || grant.length !== 1) {
    throw new Error("source_capability_authorization_denied");
  }

  const capabilities = await rows(db.prepare(
    "SELECT id, source_id, created_by_subject, status FROM source_capabilities " +
    "WHERE id=? AND tenant_id=? AND site_id=? LIMIT 2"
  ).bind(capabilityId, tenantId, siteId));
  if (capabilities.length !== 1) throw new Error("source_capability_not_found");
  const capability = capabilities[0];
  if (eventType === "submitted" && capability.created_by_subject !== principalSubject) {
    throw new Error("source_capability_submission_denied");
  }
  if (eventType !== "submitted") {
    const reviewers = await rows(db.prepare(
      "SELECT 1 AS allowed FROM tenant_source_reviewers WHERE tenant_id=? AND site_id=? " +
      "AND reviewer_subject=? AND status='active' LIMIT 2"
    ).bind(tenantId, siteId, principalSubject));
    if (reviewers.length !== 1 || capability.created_by_subject === principalSubject) {
      throw new Error("source_capability_review_denied");
    }
  }

  const canonical = canonicalizeConfiguration({
    tenant_id: tenantId, site_id: siteId, capability_id: capabilityId,
    actor_subject: principalSubject, event_type: eventType,
    evidence_ref: evidenceRef, reason,
  });
  const requestSha256 = await sha256Hex(canonical.canonicalJson, cryptoProvider);
  const findPrior = () => db.prepare(
    "SELECT request_sha256, event_id, request_id, response_json FROM source_capability_event_requests " +
    "WHERE tenant_id=? AND site_id=? AND capability_id=? AND actor_subject=? AND idempotency_key=? LIMIT 2"
  ).bind(tenantId, siteId, capabilityId, principalSubject, idempotencyKey).all();
  const readPrior = async () => {
    const result = await findPrior();
    if (!result || !Array.isArray(result.results)) throw new Error("source_capability_storage_invalid_result");
    return result.results.length === 1 ? result.results[0] : null;
  };
  const replay = prior => {
    if (!prior) return null;
    if (!equalDigest(prior.request_sha256, requestSha256)) {
      throw new Error("source_capability_event_idempotency_conflict");
    }
    try {
      return Object.freeze({ replayed: true, ...JSON.parse(prior.response_json) });
    } catch {
      throw new Error("source_capability_event_idempotency_corrupt");
    }
  };
  const prior = await readPrior();
  const existing = replay(prior);
  if (existing) return existing;

  const eventId = cryptoProvider.randomUUID();
  const requestRecordId = cryptoProvider.randomUUID();
  const auditId = cryptoProvider.randomUUID();
  const now = new Date().toISOString();
  const response = {
    capability_id: capabilityId, event_id: eventId, event_type: eventType,
    status: EVENT_STATUS[eventType], actor_subject: principalSubject,
    request_id: requestId, occurred_at: now,
  };
  const responseJson = JSON.stringify(response);
  const auditDetails = JSON.stringify({
    capability_id: capabilityId, source_id: capability.source_id,
    event_id: eventId, event_type: eventType, request_sha256: requestSha256,
  });
  const statements = [
    db.prepare(
      "INSERT INTO source_capability_events " +
      "(id,capability_id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(eventId, capabilityId, tenantId, siteId, capability.source_id,
      principalSubject, eventType, evidenceRef, reason, requestId),
    db.prepare(
      "INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id," +
      "occurred_at,request_id,details_json) VALUES (?,?,'operator',?,?,?,?,?,?,?)"
    ).bind(auditId, tenantId, principalSubject, "source_capability." + eventType,
      "source_capability", capabilityId, now, requestId, auditDetails),
    db.prepare(
      "INSERT INTO source_capability_event_requests " +
      "(id,tenant_id,site_id,capability_id,actor_subject,idempotency_key,request_sha256,event_id,event_type,request_id,response_json) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(requestRecordId, tenantId, siteId, capabilityId, principalSubject,
      idempotencyKey, requestSha256, eventId, eventType, requestId, responseJson),
  ];
  try {
    assertBatch(await db.batch(statements));
  } catch (error) {
    const raced = replay(await readPrior());
    if (raced) return raced;
    throw error;
  }
  const completed = replay(await readPrior());
  if (!completed) throw new Error("source_capability_event_write_result_unavailable");
  return Object.freeze({ replayed: false, ...JSON.parse((await readPrior()).response_json) });
}
