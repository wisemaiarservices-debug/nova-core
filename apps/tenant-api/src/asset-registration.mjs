function validText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function validIdempotencyKey(value) {
  return validText(value, 160) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function onlyKeys(value, allowed) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key));
}
async function findExisting(db, tenant, site, actor, key) {
  const result = await db.prepare(
    "SELECT r.request_sha256, r.asset_id, a.name, a.asset_type, a.external_ref, a.status FROM tenant_asset_creation_requests r JOIN assets a ON a.id = r.asset_id AND a.tenant_id = r.tenant_id AND a.site_id = r.site_id WHERE r.tenant_id = ? AND r.site_id = ? AND r.actor_subject = ? AND r.idempotency_key = ? LIMIT 2"
  ).bind(tenant, site, actor, key).all();
  if (!Array.isArray(result?.results)) throw new Error("asset_creation_idempotency_lookup_invalid");
  return result.results;
}
function replay(existing, digest) {
  if (existing.length !== 1 || existing[0].request_sha256 !== digest)
    return { error: "asset_creation_idempotency_conflict", status: 409 };
  const row = existing[0];
  return { data: { id: row.asset_id, name: row.name, asset_type: row.asset_type,
    external_ref: row.external_ref ?? null, status: row.status, created: false }, status: 200 };
}
export async function createTenantAsset(db, tenant, site, actor, requestId, idempotencyKey, requestDigest, body) {
  if (!validIdempotencyKey(idempotencyKey) || !/^[a-f0-9]{64}$/.test(requestDigest ?? "") ||
      !onlyKeys(body, ["name", "asset_type", "external_ref"]) ||
      !validText(body.name, 160) || !validText(body.asset_type, 80) ||
      (body.external_ref !== undefined && body.external_ref !== null &&
       !validText(body.external_ref, 240))) {
    return { error: "asset_creation_request_invalid", status: 400 };
  }
  const existing = await findExisting(db, tenant, site, actor, idempotencyKey);
  if (existing.length) return replay(existing, requestDigest);

  const assetId = "asset-" + crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const grantEventId = crypto.randomUUID();
  const assetEventId = crypto.randomUUID();
  const requestRecordId = crypto.randomUUID();
  const externalRef = body.external_ref ?? null;
  const statements = [
    db.prepare(
      "INSERT INTO assets (id, site_id, tenant_id, name, asset_type, external_ref, status, metadata_json) SELECT ?, ?, ?, ?, ?, ?, 'unconfigured', '{}' WHERE EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'active') AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND tenant_id = ? AND status = 'active') AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ? AND subject = ? AND role = 'tenant_owner' AND status = 'active')"
    ).bind(assetId, site, tenant, body.name, body.asset_type, externalRef,
      tenant, site, tenant, tenant, actor),
    db.prepare(
      "INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action) SELECT ?, ?, ?, 'asset', ?, 'read' WHERE EXISTS (SELECT 1 FROM assets WHERE id = ? AND tenant_id = ? AND site_id = ? AND status = 'unconfigured') AND EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = ? AND subject = ? AND role = 'tenant_owner' AND status = 'active')"
    ).bind(grantId, tenant, actor, assetId, assetId, tenant, site, tenant, actor),
    db.prepare(
      "INSERT INTO tenant_resource_grant_events (id, tenant_id, grant_id, subject, resource_type, resource_id, grant_action, event_type, actor_subject, reason, request_id) SELECT ?, ?, ?, ?, 'asset', ?, 'read', 'granted', ?, 'Initial owner read access granted at asset registration', ? WHERE EXISTS (SELECT 1 FROM tenant_resource_grants WHERE id = ? AND tenant_id = ? AND subject = ? AND resource_type = 'asset' AND resource_id = ? AND action = 'read')"
    ).bind(grantEventId, tenant, grantId, actor, assetId, actor, requestId,
      grantId, tenant, actor, assetId),
    db.prepare(
      "INSERT INTO tenant_asset_events (id, tenant_id, site_id, asset_id, actor_subject, event_type, request_id) SELECT ?, ?, ?, ?, ?, 'created', ? WHERE EXISTS (SELECT 1 FROM assets WHERE id = ? AND tenant_id = ? AND site_id = ? AND status = 'unconfigured')"
    ).bind(assetEventId, tenant, site, assetId, actor, requestId, assetId, tenant, site),
    db.prepare(
      "INSERT INTO tenant_asset_creation_requests (id, tenant_id, site_id, actor_subject, idempotency_key, request_sha256, asset_id, request_id) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tenant_asset_events WHERE tenant_id = ? AND site_id = ? AND asset_id = ? AND actor_subject = ? AND request_id = ?) AND EXISTS (SELECT 1 FROM tenant_resource_grants WHERE id = ? AND tenant_id = ? AND subject = ? AND resource_type = 'asset' AND resource_id = ? AND action = 'read')"
    ).bind(requestRecordId, tenant, site, actor, idempotencyKey, requestDigest, assetId, requestId,
      tenant, site, assetId, actor, requestId, grantId, tenant, actor, assetId),
  ];
  try {
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length ||
        results.some(result => result?.meta?.changes !== 1)) throw new Error("asset_creation_batch_incomplete");
    return { data: { id: assetId, tenant_id: tenant, site_id: site, name: body.name,
      asset_type: body.asset_type, external_ref: externalRef, status: "unconfigured",
      created_by_subject: actor, created: true }, status: 201 };
  } catch (cause) {
    const afterFailure = await findExisting(db, tenant, site, actor, idempotencyKey);
    if (afterFailure.length) return replay(afterFailure, requestDigest);
    throw cause;
  }
}
