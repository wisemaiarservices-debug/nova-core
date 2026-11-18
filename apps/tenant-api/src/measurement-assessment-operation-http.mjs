import { json, error } from "./http.mjs";
import {
  reserveMeasurementAssessmentOperation,
  readMeasurementAssessmentOperation,
  claimMeasurementAssessmentOperation,
  renewMeasurementAssessmentOperationLease,
} from "./measurement-assessment-operations.mjs";
import { completeMeasurementAssessmentOperation } from "./measurement-assessment-completion.mjs";

const ROOT = /^\/internal\/v1\/tenants\/([^/]+)\/(?:observations\/([^/]+)\/measurement-assessment-operations|measurement-assessment-operations\/([^/]+)(?:\/(claim|renew|complete))?)$/;

const validId = value => typeof value === "string" && value.length > 0 &&
  value.length <= 160 && value.trim() === value &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const onlyKeys = (value, allowed) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const iso = value => new Date(value).toISOString();

export function matchMeasurementAssessmentOperationRoute(url, method) {
  const parsed = url instanceof URL ? url : new URL(url);
  if (parsed.search || parsed.hash) return null;
  const match = parsed.pathname.match(ROOT);
  if (!match) return null;
  const tenant = match[1];
  const observation = match[2] ?? null;
  const operation = match[3] ?? null;
  const action = observation ? "reserve" : (match[4] ?? "read");
  const expectedMethod = action === "read" ? "GET" : "POST";
  if (!validId(tenant) || (observation && !validId(observation)) ||
      (operation && !validId(operation)) || method !== expectedMethod) return null;
  return { tenant, observation, operation, action };
}

async function readRows(statement) {
  const result = await statement.all();
  if (!result || !Array.isArray(result.results)) throw new Error("assessment_operation_http_storage_invalid");
  return result.results;
}

async function parseBody(request) {
  if (request.method !== "POST") return {};
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > 8192 ||
      request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return null;
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 8192) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function publicOperation(data) {
  if (!data) return data;
  const { request_digest: _digest, actor_subject: _actor, ...visible } = data;
  return { ...visible, events: Array.isArray(visible.events) ? visible.events.slice(-100) : undefined };
}

async function authorizeSite(db, tenant, subject, siteId) {
  const authorized = await readRows(db.prepare(
    "SELECT site.id FROM sites site JOIN tenants tenant_row ON tenant_row.id=site.tenant_id AND tenant_row.status='active' JOIN tenant_memberships membership ON membership.tenant_id=site.tenant_id AND membership.subject=? AND membership.status='active' JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=site.tenant_id AND grant_read.subject=membership.subject AND grant_read.resource_type='site' AND grant_read.resource_id=site.id AND grant_read.action='read' WHERE site.tenant_id=? AND site.id=? AND site.status='active' LIMIT 2"
  ).bind(subject, tenant, siteId));
  return authorized.length === 1 && authorized[0].id === siteId;
}

export async function handleMeasurementAssessmentOperationRequest(request, env, subject, requestId) {
  const route = matchMeasurementAssessmentOperationRoute(new URL(request.url), request.method);
  if (!route) return error("not_found", 404);
  if (!env?.DB || typeof subject !== "string" || !subject || typeof requestId !== "string") {
    return error("request_not_authorized", 401);
  }

  const body = await parseBody(request);
  if (body === null) return error("invalid_request_body", 400);
  const { tenant, observation, operation, action } = route;
  const now = new Date().toISOString();
  let result;

  if (action === "reserve") {
    if (!onlyKeys(body, ["predecessor_operation_id"]) ||
        (Object.hasOwn(body, "predecessor_operation_id") &&
          !validId(body.predecessor_operation_id))) return error("invalid_request_body", 400);
    const observed = await readRows(env.DB.prepare(
      "SELECT observation.site_id FROM observations observation JOIN sites site ON site.id=observation.site_id AND site.tenant_id=observation.tenant_id AND site.status='active' JOIN tenants tenant_row ON tenant_row.id=observation.tenant_id AND tenant_row.status='active' WHERE observation.tenant_id=? AND observation.id=? LIMIT 2"
    ).bind(tenant, observation));
    if (observed.length !== 1 || !await authorizeSite(env.DB, tenant, subject, observed[0].site_id)) {
      return error("not_found", 404);
    }
    const predecessor = body.predecessor_operation_id ?? null;
    const canonical = JSON.stringify([
      "nova-core-measurement-assessment-operation-v1", tenant,
      observed[0].site_id, observation, subject, predecessor,
    ]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    const requestDigest = Array.from(new Uint8Array(digest),
      byte => byte.toString(16).padStart(2, "0")).join("");
    result = await reserveMeasurementAssessmentOperation(env.DB, tenant,
      observed[0].site_id, observation, subject, requestDigest, requestId, predecessor);
  } else {
    if (!await operationVisible(env.DB, tenant, subject, operation)) return error("not_found", 404);
    if (action === "read") {
      if (Object.keys(body).length) return error("invalid_request_body", 400);
      result = await readMeasurementAssessmentOperation(env.DB, tenant, subject, operation);
    } else if (action === "claim") {
      if (!onlyKeys(body, [])) return error("invalid_request_body", 400);
      result = await claimMeasurementAssessmentOperation(env.DB, tenant, subject,
        operation, requestId, now, iso(Date.now() + 300000));
    } else if (action === "renew") {
      if (!onlyKeys(body, ["expected_lease_version", "expected_lease_request_id", "expected_lease_expires_at"]) ||
          !Number.isSafeInteger(body.expected_lease_version) || body.expected_lease_version < 1 ||
          !validId(body.expected_lease_request_id) ||
          typeof body.expected_lease_expires_at !== "string" ||
          !Number.isFinite(Date.parse(body.expected_lease_expires_at)) ||
          new Date(body.expected_lease_expires_at).toISOString() !== body.expected_lease_expires_at) {
        return error("invalid_request_body", 400);
      }
      result = await renewMeasurementAssessmentOperationLease(env.DB, tenant, subject, operation,
        body.expected_lease_version, body.expected_lease_request_id, body.expected_lease_expires_at,
        requestId, now, iso(Date.now() + 300000));
    } else if (action === "complete") {
      if (!onlyKeys(body, ["expected_lease_version", "expected_lease_request_id"]) ||
          !Number.isSafeInteger(body.expected_lease_version) || body.expected_lease_version < 1 ||
          !validId(body.expected_lease_request_id)) return error("invalid_request_body", 400);
      result = await completeMeasurementAssessmentOperation(env.DB, {
        tenant, actorSubject: subject, operationId: operation,
        expectedLeaseVersion: body.expected_lease_version,
        expectedLeaseRequestId: body.expected_lease_request_id,
        terminalRequestId: requestId, now,
      });
    }
  }

  return result?.error ? json({ error: result.error }, result.status) :
    json({ data: publicOperation(result?.data), request_id: requestId }, result?.status ?? 200);
}

async function operationVisible(db, tenant, subject, operationId) {
  const rows = await readRows(db.prepare(
    "SELECT operation.operation_id FROM measurement_assessment_operations operation JOIN tenants tenant_row ON tenant_row.id=operation.tenant_id AND tenant_row.status='active' JOIN sites site ON site.id=operation.site_id AND site.tenant_id=operation.tenant_id AND site.status='active' JOIN tenant_memberships membership ON membership.tenant_id=operation.tenant_id AND membership.subject=? AND membership.status='active' JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=operation.tenant_id AND grant_read.subject=membership.subject AND grant_read.resource_type='site' AND grant_read.resource_id=operation.site_id AND grant_read.action='read' WHERE operation.tenant_id=? AND operation.actor_subject=? AND operation.operation_id=? LIMIT 2"
  ).bind(subject, tenant, subject, operationId));
  return rows.length === 1 && rows[0].operation_id === operationId;
}
