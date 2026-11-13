import { json, error } from "./http.mjs";
import { validateWaterQualityCriteriaRegistryEntry } from "./water-quality-criteria-registry.mjs";

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

function onlyKeys(value, allowed) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key));
}
async function createCriteriaDraft(db, tenant, subject, requestId, entry) {
  if (!onlyKeys(entry, ["id", "jurisdiction", "title", "version", "published_on",
      "effective_from", "effective_to", "authority", "scope", "criteria", "review",
      "supersedes_id", "supersedes_version"])) {
    return { error: "criteria_entry_invalid", status: 422, details: [{ code: "entry.invalid_type", path: "$" }] };
  }
  if (!validId(entry.id) || !validId(entry.version, 80) ||
      typeof entry.jurisdiction !== "string" || entry.jurisdiction.trim() !== entry.jurisdiction ||
      entry.jurisdiction.length < 1 || entry.jurisdiction.length > 120 ||
      typeof entry.title !== "string" || entry.title.trim() !== entry.title ||
      entry.title.length < 1 || entry.title.length > 300 ||
      !onlyKeys(entry.authority, ["name", "source_evidence_ref", "document_digest"]) ||
      !onlyKeys(entry.scope, ["tenant_id", "site_id", "crop_ids", "irrigation_methods", "intended_uses"]) ||
      !onlyKeys(entry.review, ["status", "approvals"]) ||
      !Array.isArray(entry.criteria) ||
      entry.criteria.some(rule => !onlyKeys(rule, ["parameter", "unit", "operator", "reference_clause",
        "evidence_ref", "value", "minimum", "maximum"])) ||
      entry.scope?.tenant_id !== tenant || entry.review?.status !== "draft" ||
      (entry.review.approvals !== undefined &&
       (!Array.isArray(entry.review.approvals) || entry.review.approvals.length !== 0))) {
    return { error: "criteria_draft_scope_or_state_invalid", status: 400 };
  }
  const siteId = entry.scope.site_id ?? null;
  if (siteId !== null && !validId(siteId)) return { error: "criteria_site_id_invalid", status: 400 };
  const supersedesId = entry.supersedes_id ?? null;
  const supersedesVersion = entry.supersedes_version ?? null;
  if ((supersedesId === null) !== (supersedesVersion === null) ||
      (supersedesId !== null && (!validId(supersedesId) || !validId(supersedesVersion, 80)))) {
    return { error: "criteria_supersession_reference_invalid", status: 400 };
  }
  const validation = validateWaterQualityCriteriaRegistryEntry(entry);
  if (!validation.valid) return { error: "criteria_entry_invalid", status: 422, details: validation.errors };
  const documentDigest = entry.authority.document_digest.slice("sha256:".length).toLowerCase();
  const eventId = crypto.randomUUID();
  const insertEntry = db.prepare(
    "INSERT INTO water_quality_criteria_entries (id, tenant_id, site_id, jurisdiction, version, title, entry_json, source_document_sha256, source_evidence_ref, published_on, effective_from, effective_to, supersedes_entry_id, supersedes_entry_version, created_by_subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(entry.id, tenant, siteId, entry.jurisdiction, entry.version, entry.title,
    JSON.stringify(entry), documentDigest, entry.authority.source_evidence_ref,
    entry.published_on, entry.effective_from, entry.effective_to ?? null,
    supersedesId, supersedesVersion, subject);
  const insertEvent = db.prepare(
    "INSERT INTO water_quality_criteria_events (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id) VALUES (?, ?, ?, ?, 'draft_created', ?, ?)"
  ).bind(eventId, tenant, entry.id, entry.version, subject, requestId);
  const results = await db.batch([insertEntry, insertEvent]);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => !result?.meta || result.meta.changes !== 1)) {
    throw new Error("criteria_draft_batch_incomplete");
  }
  return { data: { id: entry.id, version: entry.version, jurisdiction: entry.jurisdiction,
    site_id: siteId, status: "draft", created_by_subject: subject }, status: 201 };
}
 
async function readCriteriaRegistry(db, tenant, entryId, version) {
  if (entryId === null) {
    const result = await rows(db.prepare(
      "SELECT id, site_id, jurisdiction, version, title, entry_json, source_document_sha256, source_evidence_ref, published_on, effective_from, effective_to, supersedes_entry_id, supersedes_entry_version, created_by_subject, created_at FROM water_quality_criteria_entries WHERE tenant_id = ? ORDER BY jurisdiction, id, version LIMIT 100"
    ).bind(tenant));
    return result.map(row => ({ ...row, entry: JSON.parse(row.entry_json), entry_json: undefined }));
  }
  const result = await rows(db.prepare(
    "SELECT id, site_id, jurisdiction, version, title, entry_json, source_document_sha256, source_evidence_ref, published_on, effective_from, effective_to, supersedes_entry_id, supersedes_entry_version, created_by_subject, created_at FROM water_quality_criteria_entries WHERE tenant_id = ? AND id = ? AND version = ? LIMIT 1"
  ).bind(tenant, entryId, version));
  if (result.length !== 1) return null;
  const row = result[0];
  return { ...row, entry: JSON.parse(row.entry_json), entry_json: undefined };
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "POST") return error("not_found", 404);
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/(sites|assets|sources|observations|audit-events)\/([^/]+)$/);
    const criteriaCreate = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/water-quality-criteria$/);
    const criteriaList = request.method === "GET" ? criteriaCreate : null;
    const criteriaDetail = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/water-quality-criteria\/([^/]+)\/([^/]+)$/);
    if ((!match && !criteriaCreate && !criteriaDetail) || url.search || url.hash ||
        (request.method === "POST" && (!criteriaCreate || criteriaDetail || match))) return error("not_found", 404);
    const tenant = match?.[1] ?? criteriaCreate?.[1] ?? criteriaDetail?.[1];
    const resourceId = match?.[3];
    const entryId = criteriaDetail?.[2] ?? null;
    const version = criteriaDetail?.[3] ?? null;
    if (!validId(tenant, 120) || (resourceId && !validId(resourceId)) ||
        (entryId && (!validId(entryId) || !validId(version, 80)))) return error("not_found", 404);

    const subject = request.headers.get("x-nova-verified-subject");
    const issuer = request.headers.get("x-nova-verified-issuer");
    const audience = request.headers.get("x-nova-verified-audience");
    const issuedAt = Number(request.headers.get("x-nova-gateway-issued-at"));
    const requestId = request.headers.get("x-nova-request-id");
    const now = Math.floor(Date.now() / 1000);
    if (!validSubject(subject) || issuer !== env.ACCESS_ISSUER || audience !== env.ACCESS_AUDIENCE ||
        !Number.isInteger(issuedAt) || issuedAt > now + 30 || issuedAt < now - 120 ||
        !validId(requestId, 80) ||
        !(await verifyEnvelope(env.INTERNAL_AUTH_SECRET, request.method, url.pathname, request.headers))) {
      return error("request_not_authorized", 401);
    }
    if (!env.DB) return error("storage_unavailable", 503);

    let draftBody = null;
    if (request.method === "POST") {
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
          !Number.isFinite(declaredLength) || declaredLength > 65536) return error("invalid_request_body", 400);
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 65536) return error("invalid_request_body", 400);
        draftBody = JSON.parse(raw);
      } catch { return error("invalid_request_body", 400); }
      if (draftBody === null || typeof draftBody !== "object" || Array.isArray(draftBody) ||
          Object.keys(draftBody).length !== 1 || !Object.hasOwn(draftBody, "entry")) return error("invalid_request_body", 400);
    }
    try {
      if (!(await consumeRequestId(env.DB, requestId, issuedAt))) return error("request_not_authorized", 401);
      if (criteriaCreate || criteriaDetail) {
        const membership = await rows(env.DB.prepare(
          "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
        ).bind(subject, tenant));
        if (membership.length !== 1 || membership[0].subject !== subject ||
            membership[0].tenant_id !== tenant || membership[0].membership_status !== "active" ||
            membership[0].tenant_status !== "active") return error("not_found", 404);
        if (request.method === "POST") {
          if (!["tenant_owner", "tenant_admin"].includes(membership[0].role)) return error("not_found", 404);
          const created = await createCriteriaDraft(env.DB, tenant, subject, requestId, draftBody.entry);
          return created.error
            ? json({ error: created.error, details: created.details }, created.status)
            : json({ data: created.data, request_id: requestId }, created.status);
        }
        if (!ROLE_ACTIONS[membership[0].role]?.has("read")) return error("not_found", 404);
        const data = await readCriteriaRegistry(env.DB, tenant, entryId, version);
        return data === null ? error("not_found", 404) : json({ data, request_id: requestId });
      }
      const routeType = match[2];
      const type = routeType === "audit-events" ? "audit_event" : routeType.slice(0, -1);
      const record = await readResource(env.DB, subject, tenant, type, resourceId);
      return record ? json({ data: record, request_id: requestId }) : error("not_found", 404);
    } catch {
      return error("storage_unavailable", 503);
    }
  },
};
