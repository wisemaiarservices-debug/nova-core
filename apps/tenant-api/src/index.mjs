import { json, error } from "./http.mjs";

const ROLE_ACTIONS = {
  tenant_owner: new Set(["read", "create", "update", "delete", "ingest", "manage_members"]),
  tenant_admin: new Set(["read", "create", "update", "delete", "ingest"]),
  operator: new Set(["read", "ingest"]), analyst: new Set(["read"]),
  viewer: new Set(["read"]), service: new Set(["read", "ingest"]),
};
const RESOURCE_SQL = {
  site: "SELECT id, tenant_id, name, description, latitude, longitude, timezone, status, metadata_json, created_at, updated_at FROM sites WHERE tenant_id = ? AND id = ? LIMIT 1",
  asset: "SELECT id, tenant_id, site_id, name, asset_type, external_ref, status, metadata_json, created_at, updated_at FROM assets WHERE tenant_id = ? AND id = ? LIMIT 1",
  source: "SELECT id, tenant_id, site_id, module, provider, source_type, display_name, verification_status, verification_method, license_reference, metadata_json, created_at, updated_at FROM sources WHERE tenant_id = ? AND id = ? LIMIT 1",
  observation: "SELECT id, tenant_id, site_id, asset_id, source_id, module, metric, value, unit, observed_at, ingested_at, verification_status, provenance_json, quality_flags_json, retention_until FROM observations WHERE tenant_id = ? AND id = ? LIMIT 1",
  audit_event: "SELECT id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, request_id, details_json FROM audit_events WHERE tenant_id = ? AND id = ? LIMIT 1",
};

function validSubject(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function validId(value, max = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function canonicalEnvelope(method, path, headers) {
  return JSON.stringify([method, path,
    headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"),
    headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"),
    headers.get("x-nova-request-id")]);
}
async function verifyEnvelope(secret, method, path, headers) {
  if (typeof secret !== "string" || secret.length < 32) return false;
  const encoded = headers.get("x-nova-internal-signature");
  if (typeof encoded !== "string" || !/^[a-f0-9]{64}$/.test(encoded)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(encoded.match(/.{2}/g), pair => parseInt(pair, 16));
    return await crypto.subtle.verify("HMAC", key, signature,
      new TextEncoder().encode(canonicalEnvelope(method, path, headers)));
  } catch { return false; }
}
async function rows(statement) {
  const result = await statement.all();
  if (!result || !Array.isArray(result.results)) throw new Error("storage_invalid_result");
  return result.results;
}
async function consumeRequestId(db, requestId, issuedAt) {
  const result = await db.prepare(
    "INSERT INTO internal_request_nonces (request_id, issued_at, expires_at) VALUES (?, ?, ?) ON CONFLICT(request_id) DO NOTHING"
  ).bind(requestId, issuedAt, issuedAt + 600).run();
  if (!result || !result.meta || !Number.isInteger(result.meta.changes)) {
    throw new Error("nonce_storage_invalid_result");
  }
  return result.meta.changes === 1;
}
async function readResource(db, subject, tenant, type, id) {
  const membership = await rows(db.prepare(
    "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
  ).bind(subject, tenant));
  if (membership.length !== 1) return null;
  const m = membership[0];
  if (m.subject !== subject || m.tenant_id !== tenant || m.membership_status !== "active" ||
      m.tenant_status !== "active" || !ROLE_ACTIONS[m.role]?.has("read")) return null;
  const grantRows = await rows(db.prepare(
    "SELECT subject, tenant_id, resource_type, resource_id, action FROM tenant_resource_grants WHERE tenant_id = ? AND subject = ? AND resource_type = ? AND resource_id = ?"
  ).bind(tenant, subject, type, id));
  if (!grantRows.some(g => g.subject === subject && g.tenant_id === tenant &&
      g.resource_type === type && g.resource_id === id && g.action === "read")) return null;
  const record = await rows(db.prepare(RESOURCE_SQL[type]).bind(tenant, id));
  if (record.length !== 1 || record[0].tenant_id !== tenant || record[0].id !== id) return null;
  return record[0];
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") return error("not_found", 404);
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/(sites|assets|sources|observations|audit-events)\/([^/]+)$/);
    if (!match || url.search || url.hash) return error("not_found", 404);
    const [, tenant, routeType, resourceId] = match;
    if (!validId(tenant, 120) || !validId(resourceId)) return error("not_found", 404);

    // The gateway identity envelope is authenticated by HMAC as well as the
    // private Service Binding boundary; neither mechanism replaces tenant grants.
    const subject = request.headers.get("x-nova-verified-subject");
    const issuer = request.headers.get("x-nova-verified-issuer");
    const audience = request.headers.get("x-nova-verified-audience");
    const issuedAt = Number(request.headers.get("x-nova-gateway-issued-at"));
    const requestId = request.headers.get("x-nova-request-id");
    const now = Math.floor(Date.now() / 1000);
    if (!validSubject(subject) || issuer !== env.ACCESS_ISSUER || audience !== env.ACCESS_AUDIENCE ||
        !Number.isInteger(issuedAt) || issuedAt > now + 30 ||
        issuedAt < now - 120 || !validId(requestId, 80) ||
        !(await verifyEnvelope(env.INTERNAL_AUTH_SECRET, request.method, url.pathname, request.headers))) {
      return error("request_not_authorized", 401);
    }
    if (!env.DB) return error("storage_unavailable", 503);
    const type = routeType === "audit-events" ? "audit_event" :
      routeType.slice(0, -1);
    try {
      if (!(await consumeRequestId(env.DB, requestId, issuedAt))) {
        return error("request_not_authorized", 401);
      }
      const record = await readResource(env.DB, subject, tenant, type, resourceId);
      return record ? json({ data: record, request_id: requestId }) : error("not_found", 404);
    } catch {
      return error("storage_unavailable", 503);
    }
  },
};
