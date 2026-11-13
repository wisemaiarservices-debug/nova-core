function validToken(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
async function all(statement) {
  const result = await statement.all();
  if (!result || !Array.isArray(result.results)) throw new Error("configuration_review_storage_invalid_result");
  return result.results;
}
function assertBatch(results) {
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => !result || result.success === false ||
        !result.meta || result.meta.changes !== 1)) {
    throw new Error("configuration_review_atomic_write_failed");
  }
}

/**
 * A different active tenant owner/admin with an exact site update grant may
 * approve or reject a submitted configuration. The creator cannot self-review.
 * Database lifecycle triggers remain the final transition guard.
 */
export async function reviewSiteConfiguration({
  db, principalSubject, tenantId, siteId, version, decision, reason, requestId,
  cryptoProvider = globalThis.crypto,
}) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new Error("configuration_review_storage_unavailable");
  }
  if (!validToken(tenantId, 120) || !validToken(siteId, 160) ||
      !/^v[1-9][0-9]{0,30}$/.test(version ?? "") ||
      !validToken(requestId, 80) ||
      typeof principalSubject !== "string" || principalSubject.length < 1 ||
      principalSubject.length > 200 || principalSubject.trim() !== principalSubject ||
      !["approve", "reject"].includes(decision) ||
      typeof reason !== "string" || reason.trim() !== reason || reason.length < 5 || reason.length > 1000) {
    throw new Error("configuration_review_request_invalid");
  }

  const memberships = await all(db.prepare(
    "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status " +
    "FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id " +
    "WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
  ).bind(principalSubject, tenantId));
  if (memberships.length !== 1 || memberships[0].subject !== principalSubject ||
      memberships[0].tenant_id !== tenantId || memberships[0].membership_status !== "active" ||
      memberships[0].tenant_status !== "active" ||
      !["tenant_owner", "tenant_admin"].includes(memberships[0].role)) {
    throw new Error("configuration_review_authorization_denied");
  }

  const grants = await all(db.prepare(
    "SELECT subject, tenant_id, resource_type, resource_id, action FROM tenant_resource_grants " +
    "WHERE tenant_id = ? AND subject = ? AND resource_type = 'site' AND resource_id = ? AND action = 'update' LIMIT 2"
  ).bind(tenantId, principalSubject, siteId));
  if (grants.length !== 1 || grants[0].subject !== principalSubject ||
      grants[0].tenant_id !== tenantId || grants[0].resource_type !== "site" ||
      grants[0].resource_id !== siteId || grants[0].action !== "update") {
    throw new Error("configuration_review_authorization_denied");
  }

  const configurations = await all(db.prepare(
    "SELECT id, created_by_subject, configuration_version FROM tenant_site_configurations " +
    "WHERE tenant_id = ? AND site_id = ? AND configuration_version = ? LIMIT 2"
  ).bind(tenantId, siteId, version));
  if (configurations.length !== 1) throw new Error("configuration_review_not_found");
  const configuration = configurations[0];
  if (configuration.created_by_subject === principalSubject) {
    throw new Error("configuration_self_review_forbidden");
  }

  const assignments = await all(db.prepare(
    "SELECT reviewer_role FROM tenant_site_configuration_reviewers WHERE tenant_id = ? AND site_id = ? AND reviewer_subject = ? AND status = 'active' LIMIT 2"
  ).bind(tenantId, siteId, principalSubject));
  if (assignments.length !== 1 ||
      !["engineering_reviewer", "operations_reviewer"].includes(assignments[0].reviewer_role)) {
    throw new Error("configuration_review_assignment_required");
  }
  const reviewerRole = assignments[0].reviewer_role;

  const events = await all(db.prepare(
    "SELECT event_type FROM tenant_site_configuration_events WHERE tenant_id = ? AND site_id = ? " +
    "AND configuration_id = ? ORDER BY rowid DESC LIMIT 1"
  ).bind(tenantId, siteId, configuration.id));
  if (events.length !== 1 || events[0].event_type !== "submitted_for_review") {
    throw new Error("configuration_review_state_conflict");
  }

  const eventType = decision === "approve" ? "approved_for_review" : "rejected";
  const eventId = cryptoProvider.randomUUID();
  const auditId = cryptoProvider.randomUUID();
  const occurredAt = new Date().toISOString();
  const details = JSON.stringify({
    configuration_id: configuration.id, configuration_version: version,
    decision, reason, reviewer_role: reviewerRole,
  });
  const results = await db.batch([
    db.prepare(
      "INSERT INTO tenant_site_configuration_events " +
      "(id, configuration_id, tenant_id, site_id, event_type, actor_subject, reason, request_id, occurred_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(eventId, configuration.id, tenantId, siteId, eventType,
      principalSubject, reason, requestId, occurredAt),
    db.prepare(
      "INSERT INTO audit_events (id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, request_id, details_json) " +
      "VALUES (?, ?, 'operator', ?, ?, 'site', ?, ?, ?, ?)"
    ).bind(auditId, tenantId, principalSubject,
      decision === "approve" ? "configuration.approved_for_review" : "configuration.rejected",
      siteId, occurredAt, requestId, details),
  ]);
  assertBatch(results);
  return Object.freeze({
    configuration_id: configuration.id, site_id: siteId,
    configuration_version: version, status: eventType,
    reviewed_by_subject: principalSubject, reviewer_role: reviewerRole, reviewed_at: occurredAt,
    reason, operational_decision: "not_authorized",
  });
}
