const MAX_REASON_LENGTH = 1000;

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
}
function validReason(value) {
  return typeof value === "string" && value.trim() === value &&
    value.length >= 1 && value.length <= MAX_REASON_LENGTH;
}
function validActor(value) {
  return value && typeof value.issuer === "string" && value.issuer.length > 0 &&
    value.issuer.length <= 500 && typeof value.subject === "string" &&
    value.subject.length > 0 && value.subject.length <= 200;
}
async function exactlyOne(statement) {
  const result = await statement.all();
  return Array.isArray(result?.results) && result.results.length === 1
    ? result.results[0] : null;
}

/** Lists pending requests only for an active tenant owner. */
export async function listPendingIdentityLinkRequests(db, tenantId, actor, limit = 50) {
  if (!validId(tenantId) || !validActor(actor) ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { error: "identity_link_review_input_invalid", status: 400 };
  }
  const owner = await exactlyOne(db.prepare(
    "SELECT m.subject FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.tenant_id = ? AND m.subject = ? AND m.role = 'tenant_owner' AND m.status = 'active' AND t.status = 'active' LIMIT 2"
  ).bind(tenantId, actor.subject));
  if (!owner) return { error: "not_found", status: 404 };
  const result = await db.prepare(
    "SELECT r.id, r.supabase_issuer, r.supabase_subject, r.cloudflare_issuer, r.cloudflare_subject, r.created_at FROM tenant_identity_link_requests r WHERE r.status = 'pending' AND r.cloudflare_issuer = ? AND r.cloudflare_subject <> ? AND EXISTS (SELECT 1 FROM tenant_memberships requester WHERE requester.tenant_id = ? AND requester.subject = r.cloudflare_subject AND requester.status = 'active') ORDER BY r.created_at ASC, r.id ASC LIMIT ?"
  ).bind(actor.issuer, actor.subject, tenantId, limit).all();
  if (!Array.isArray(result?.results)) throw new Error("identity_link_review_storage_invalid");
  return { data: result.results, status: 200 };
}

/** Owner decision is recorded as an immutable event before the guarded state transition. */
export async function decideIdentityLinkRequest(db, tenantId, requestId, actor,
  decision, reason, idempotencyKey, now = new Date()) {
  if (!validId(tenantId) || !validId(requestId) || !validActor(actor) ||
      !["approve", "reject", "revoke"].includes(decision) || !validReason(reason) ||
      !validId(idempotencyKey) || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { error: "identity_link_review_input_invalid", status: 400 };
  }
  const priorEvent = await exactlyOne(db.prepare(
    "SELECT link_request_id, event_type, tenant_id, actor_cloudflare_issuer, actor_cloudflare_subject, reason, created_at FROM tenant_identity_link_events WHERE request_id = ? LIMIT 2"
  ).bind(idempotencyKey));
  const expectedEvent = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "revoked";
  if (priorEvent) {
    if (priorEvent.link_request_id === requestId && priorEvent.event_type === expectedEvent &&
        priorEvent.tenant_id === tenantId && priorEvent.actor_cloudflare_issuer === actor.issuer &&
        priorEvent.actor_cloudflare_subject === actor.subject && priorEvent.reason === reason) {
      return { data: { request_id: requestId, tenant_id: tenantId, status: expectedEvent,
        decided_by: { issuer: actor.issuer, subject: actor.subject },
        decided_at: priorEvent.created_at }, status: 200 };
    }
    return { error: "identity_link_idempotency_conflict", status: 409 };
  }
  const request = await exactlyOne(db.prepare(
    "SELECT id, status, tenant_id FROM tenant_identity_link_requests WHERE id = ? LIMIT 2"
  ).bind(requestId));
  if (!request) return { error: "not_found", status: 404 };
  const expected = decision === "revoke" ? "approved" : "pending";
  if (request.status !== expected || (request.tenant_id !== null && request.tenant_id !== tenantId)) {
    return { error: "identity_link_request_conflict", status: 409 };
  }
  const eventType = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "revoked";
  const eventId = crypto.randomUUID();
  const decidedAt = now.toISOString();
  const event = db.prepare(
    "INSERT INTO tenant_identity_link_events (id, link_request_id, event_type, previous_status, new_status, tenant_id, actor_cloudflare_issuer, actor_cloudflare_subject, reason, request_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tenant_identity_link_requests r JOIN tenants t ON t.id = ? AND t.status = 'active' WHERE r.id = ? AND r.status = ? AND (r.tenant_id IS NULL OR r.tenant_id = ?) AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = t.id AND m.subject = ? AND m.role = 'tenant_owner' AND m.status = 'active') AND r.cloudflare_issuer = ? AND (? = 'revoke' OR r.cloudflare_subject <> ?) AND (? = 'revoke' OR EXISTS (SELECT 1 FROM tenant_memberships requester WHERE requester.tenant_id = t.id AND requester.subject = r.cloudflare_subject AND requester.status = 'active')))"
  ).bind(eventId, requestId, eventType, expected, eventType, tenantId,
    actor.issuer, actor.subject, reason, idempotencyKey, tenantId, requestId, expected,
    tenantId, actor.subject, actor.issuer, decision, actor.subject, decision);
  const update = db.prepare(
    "UPDATE tenant_identity_link_requests SET status = ?, tenant_id = ?, decided_by_cloudflare_issuer = ?, decided_by_cloudflare_subject = ?, reason = ?, decided_at = ? WHERE id = ? AND status = ? AND (tenant_id IS NULL OR tenant_id = ?) AND changes() = 1"
  ).bind(eventType, tenantId, actor.issuer, actor.subject, reason, decidedAt,
    requestId, expected, tenantId);
  let results;
  try {
    results = await db.batch([event, update]);
  } catch (error) {
    // A concurrent retry may have committed the same idempotency key first.
    const concurrentEvent = await exactlyOne(db.prepare(
      "SELECT link_request_id, event_type, tenant_id, actor_cloudflare_issuer, actor_cloudflare_subject, reason, created_at FROM tenant_identity_link_events WHERE request_id = ? LIMIT 2"
    ).bind(idempotencyKey));
    if (concurrentEvent && concurrentEvent.link_request_id === requestId &&
        concurrentEvent.event_type === eventType && concurrentEvent.tenant_id === tenantId &&
        concurrentEvent.actor_cloudflare_issuer === actor.issuer &&
        concurrentEvent.actor_cloudflare_subject === actor.subject &&
        concurrentEvent.reason === reason) {
      return { data: { request_id: requestId, tenant_id: tenantId, status: eventType,
        decided_by: { issuer: actor.issuer, subject: actor.subject },
        decided_at: concurrentEvent.created_at }, status: 200 };
    }
    if (concurrentEvent) return { error: "identity_link_idempotency_conflict", status: 409 };
    throw error;
  }
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => !result?.meta || !Number.isInteger(result.meta.changes))) {
    throw new Error("identity_link_review_batch_invalid");
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    // The guarded INSERT can affect zero rows when an identical concurrent
    // decision has already committed. Re-read the idempotency key before
    // classifying the losing request as a conflict.
    const concurrentEvent = await exactlyOne(db.prepare(
      "SELECT link_request_id, event_type, tenant_id, actor_cloudflare_issuer, actor_cloudflare_subject, reason, created_at FROM tenant_identity_link_events WHERE request_id = ? LIMIT 2"
    ).bind(idempotencyKey));
    if (concurrentEvent && concurrentEvent.link_request_id === requestId &&
        concurrentEvent.event_type === eventType && concurrentEvent.tenant_id === tenantId &&
        concurrentEvent.actor_cloudflare_issuer === actor.issuer &&
        concurrentEvent.actor_cloudflare_subject === actor.subject &&
        concurrentEvent.reason === reason) {
      return { data: { request_id: requestId, tenant_id: tenantId, status: eventType,
        decided_by: { issuer: actor.issuer, subject: actor.subject },
        decided_at: concurrentEvent.created_at }, status: 200 };
    }
    if (concurrentEvent) return { error: "identity_link_idempotency_conflict", status: 409 };
    return { error: "identity_link_request_conflict", status: 409 };
  }
  return { data: { request_id: requestId, tenant_id: tenantId, status: eventType,
    decided_by: { issuer: actor.issuer, subject: actor.subject }, decided_at: decidedAt }, status: 200 };
}
