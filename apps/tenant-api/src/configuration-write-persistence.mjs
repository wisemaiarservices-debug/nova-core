import { authorizeConfigurationWrite } from "./configuration-write-authorization.mjs";
import { prepareConfigurationSnapshot, sha256Hex, equalDigest } from "./configuration-write-contract.mjs";

const SUPPORTED_CONFIGURATION_SCHEMA_ID = "nova.client-config.v1";

function validToken(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
async function all(statement) {
  const result = await statement.all();
  if (!result || !Array.isArray(result.results)) throw new Error("configuration_storage_invalid_result");
  return result.results;
}
async function one(statement) {
  const result = await all(statement);
  return result.length === 1 ? result[0] : null;
}
function assertBatch(results) {
  if (!Array.isArray(results) || results.length !== 5 ||
      results.some(result => !result || result.success === false ||
        !result.meta || result.meta.changes !== 1)) {
    throw new Error("configuration_atomic_write_failed");
  }
}
async function existingIdempotency(db, tenantId, subject, key) {
  return one(db.prepare(
    "SELECT request_sha256, configuration_id, status, response_json FROM tenant_site_configuration_idempotency WHERE tenant_id = ? AND subject = ? AND idempotency_key = ? LIMIT 2"
  ).bind(tenantId, subject, key));
}

// Requires a previously verified gateway principal. All database writes occur
// in one D1 batch: reservation, immutable snapshot, review event, audit, completion.
export async function createSiteConfiguration({
  db, principalSubject, tenantId, siteId, idempotencyKey, requestId,
  payload, schemaId, suppliedDigest, cryptoProvider = globalThis.crypto,
}) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new Error("configuration_storage_unavailable");
  }
  if (!validToken(tenantId, 120) || !validToken(siteId, 160) ||
      !validToken(idempotencyKey, 200) || !validToken(requestId, 80) ||
      typeof principalSubject !== "string" || principalSubject.length < 1 ||
      principalSubject.length > 200 || principalSubject.trim() !== principalSubject) {
    throw new Error("configuration_request_invalid");
  }

  const membershipRows = await all(db.prepare(
    "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
  ).bind(principalSubject, tenantId));
  const grantRows = await all(db.prepare(
    "SELECT subject, tenant_id, resource_type, resource_id, action FROM tenant_resource_grants WHERE tenant_id = ? AND subject = ? AND resource_type = 'site' AND resource_id = ? AND action = 'create'"
  ).bind(tenantId, principalSubject, siteId));
  const authorization = authorizeConfigurationWrite({
    principalSubject, tenantId, siteId, membershipRows, grantRows,
  });
  if (!authorization.allowed) throw new Error("configuration_authorization_denied");

  const snapshot = await prepareConfigurationSnapshot({
    payload, schemaId, expectedSchemaId: SUPPORTED_CONFIGURATION_SCHEMA_ID, suppliedDigest, cryptoProvider,
  });
  const requestSha256 = await sha256Hex(
    JSON.stringify([siteId, snapshot.schemaId, snapshot.canonicalJson]), cryptoProvider
  );

  const prior = await existingIdempotency(db, tenantId, principalSubject, idempotencyKey);
  if (prior) {
    if (!equalDigest(prior.request_sha256, requestSha256)) {
      throw new Error("configuration_idempotency_conflict");
    }
    if (prior.status !== "completed" || typeof prior.response_json !== "string") {
      throw new Error("configuration_idempotency_incomplete");
    }
    return Object.freeze({ replayed: true, ...JSON.parse(prior.response_json) });
  }

  const configurationId = cryptoProvider.randomUUID();
  const eventId = cryptoProvider.randomUUID();
  const auditId = cryptoProvider.randomUUID();
  const now = new Date().toISOString();
  const auditDetails = JSON.stringify({
    configuration_id: configurationId, schema_id: snapshot.schemaId,
    content_sha256: snapshot.contentSha256, request_sha256: requestSha256,
  });
  const statements = [
    db.prepare(
      "INSERT INTO tenant_site_configuration_idempotency (tenant_id, subject, idempotency_key, request_sha256, configuration_id, status) VALUES (?, ?, ?, ?, ?, 'pending')"
    ).bind(tenantId, principalSubject, idempotencyKey, requestSha256, configurationId),
    db.prepare(
      "INSERT INTO tenant_site_configurations (id, tenant_id, site_id, configuration_version, schema_id, configuration_json, content_sha256, created_by_subject, request_id, created_at) VALUES (?, ?, ?, 'v' || CAST((SELECT COALESCE(MAX(CAST(substr(configuration_version, 2) AS INTEGER)), 0) + 1 FROM tenant_site_configurations WHERE tenant_id = ? AND site_id = ?) AS TEXT), ?, ?, ?, ?, ?, ?)"
    ).bind(configurationId, tenantId, siteId, tenantId, siteId, snapshot.schemaId,
      snapshot.canonicalJson, snapshot.contentSha256, principalSubject, requestId, now),
    db.prepare(
      "INSERT INTO tenant_site_configuration_events (id, configuration_id, tenant_id, site_id, event_type, actor_subject, reason, request_id, occurred_at) VALUES (?, ?, ?, ?, 'submitted_for_review', ?, NULL, ?, ?)"
    ).bind(eventId, configurationId, tenantId, siteId, principalSubject, requestId, now),
    db.prepare(
      "INSERT INTO audit_events (id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, request_id, details_json) VALUES (?, ?, 'operator', ?, 'configuration.created_for_review', 'site', ?, ?, ?, ?)"
    ).bind(auditId, tenantId, principalSubject, siteId, now, requestId, auditDetails),
    db.prepare(
      "UPDATE tenant_site_configuration_idempotency SET status = 'completed', response_json = (SELECT json_object('configuration_id', c.id, 'configuration_version', c.configuration_version, 'site_id', c.site_id, 'schema_id', c.schema_id, 'content_sha256', c.content_sha256, 'request_id', c.request_id, 'created_at', c.created_at) FROM tenant_site_configurations c WHERE c.id = tenant_site_configuration_idempotency.configuration_id AND c.tenant_id = tenant_site_configuration_idempotency.tenant_id) WHERE tenant_id = ? AND subject = ? AND idempotency_key = ? AND status = 'pending'"
    ).bind(tenantId, principalSubject, idempotencyKey),
  ];
  try {
    assertBatch(await db.batch(statements));
  } catch (error) {
    // A concurrent identical request may have won the unique-key race. Only
    // replay a fully committed row with the exact same canonical request hash.
    const raced = await existingIdempotency(db, tenantId, principalSubject, idempotencyKey);
    if (raced && equalDigest(raced.request_sha256, requestSha256) &&
        raced.status === "completed" && typeof raced.response_json === "string") {
      return Object.freeze({ replayed: true, ...JSON.parse(raced.response_json) });
    }
    throw error;
  }
  const completed = await existingIdempotency(db, tenantId, principalSubject, idempotencyKey);
  if (!completed || completed.status !== "completed" || !completed.response_json) {
    throw new Error("configuration_write_result_unavailable");
  }
  return Object.freeze({ replayed: false, ...JSON.parse(completed.response_json) });
}
