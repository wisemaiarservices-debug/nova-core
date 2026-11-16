function validText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\\u0000-\\u001f\\u007f]/.test(value);
}
function validIdempotencyKey(value) {
  return validText(value, 160) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function onlyName(body) {
  return body !== null && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).every(key => key === "name") && validText(body.name, 160);
}
async function findExisting(db, tenant, actor, key) {
  const result = await db.prepare(
    "SELECT r.request_sha256, r.site_id, s.name, s.status, s.timezone FROM tenant_site_creation_requests r JOIN sites s ON s.id = r.site_id AND s.tenant_id = r.tenant_id WHERE r.tenant_id = ? AND r.actor_subject = ? AND r.idempotency_key = ? LIMIT 2"
  ).bind(tenant, actor, key).all();
  if (!Array.isArray(result?.results)) throw new Error("site_creation_idempotency_lookup_invalid");
  return result.results;
}
function replay(existing, digest) {
  if (existing.length !== 1 || existing[0].request_sha256 !== digest)
    return { error: "site_creation_idempotency_conflict", status: 409 };
  const row = existing[0];
  return { data: { id: row.site_id, name: row.name, status: row.status,
    timezone: row.timezone ?? null, created: false }, status: 200 };
}
export async function createTenantSite(db, tenant, actor, requestId, idempotencyKey, requestDigest, body) {
  if (!validIdempotencyKey(idempotencyKey) || !/^[a-f0-9]{64}$/.test(requestDigest ?? "") ||
      !onlyName(body)) return { error: "site_creation_request_invalid", status: 400 };
  const existing = await findExisting(db, tenant, actor, idempotencyKey);
  if (existing.length) return replay(existing, requestDigest);

  const siteId = "site-" + crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const grantEventId = crypto.randomUUID();
  const siteEventId = crypto.randomUUID();
  const requestRecordId = crypto.randomUUID();
  const statements = [
    db.prepare(
      "INSERT INTO sites (id, name, status, metadata_json, tenant_id) SELECT ?, ?, 'active', '{}', ? WHERE EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'active') AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ? AND subject = ? AND role = 'tenant_owner' AND status = 'active')"
    ).bind(siteId, body.name, tenant, tenant, tenant, actor),
    db.prepare(
      "INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action) SELECT ?, ?, ?, 'site', ?, 'read' WHERE EXISTS (SELECT 1 FROM sites WHERE id = ? AND tenant_id = ? AND status = 'active') AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ? AND subject = ? AND role = 'tenant_owner' AND status = 'active')"
    ).bind(grantId, tenant, actor, siteId, siteId, tenant, tenant, actor),
    db.prepare(
      "INSERT INTO tenant_site_grant_events (id, tenant_id, grant_id, subject, site_id, grant_action, event_type, actor_subject, reason, request_id) VALUES (?, ?, ?, ?, ?, 'read', 'granted', ?, 'Initial owner read access granted at site creation', ?)"
    ).bind(grantEventId, tenant, grantId, actor, siteId, actor, requestId),
    db.prepare(
      "INSERT INTO tenant_site_events (id, tenant_id, site_id, event_type, actor_subject, request_id) VALUES (?, ?, ?, 'created', ?, ?)"
    ).bind(siteEventId, tenant, siteId, actor, requestId),
    db.prepare(
      "INSERT INTO tenant_site_creation_requests (id, tenant_id, actor_subject, idempotency_key, request_sha256, site_id, request_id) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tenant_site_events WHERE tenant_id = ? AND site_id = ? AND request_id = ?) AND EXISTS (SELECT 1 FROM tenant_resource_grants WHERE tenant_id = ? AND subject = ? AND resource_type = 'site' AND resource_id = ? AND action = 'read')"
    ).bind(requestRecordId, tenant, actor, idempotencyKey, requestDigest, siteId, requestId,
      tenant, siteId, requestId, tenant, actor, siteId),
  ];
  try {
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length ||
        results.some(result => result?.meta?.changes !== 1)) throw new Error("site_creation_batch_incomplete");
    return { data: { id: siteId, tenant_id: tenant, name: body.name,
      status: "active", created_by_subject: actor, created: true }, status: 201 };
  } catch (cause) {
    const afterFailure = await findExisting(db, tenant, actor, idempotencyKey);
    if (afterFailure.length) return replay(afterFailure, requestDigest);
    throw cause;
  }
}
