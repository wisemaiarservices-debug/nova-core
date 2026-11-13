import { verifyHumanAccessToken } from "./human-access-auth.mjs";
import { error, boundedJsonResponse } from "./http.mjs";

const ROUTES = new Map([
  ["sites", "sites"], ["assets", "assets"], ["sources", "sources"],
  ["observations", "observations"], ["audit-events", "audit-events"],
]);
function validPathId(value, max = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function validSubject(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function canonicalEnvelope(method, path, headers) {
  return JSON.stringify([method, path,
    headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"),
    headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"),
    headers.get("x-nova-request-id")]);
}
async function signEnvelope(secret, method, path, headers) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("internal_auth_not_configured");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(canonicalEnvelope(method, path, headers)));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function createGateway({ verifyAccessToken = (token, config) => verifyHumanAccessToken(token, config) } = {}) {
  return {
    async fetch(request, env) {
      if (request.method !== "GET" && request.method !== "POST") return error("not_found", 404);
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/(sites|assets|sources|observations|audit-events)\/([^/]+)$/);
      const criteriaCreate = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/water-quality-criteria$/);
      const criteriaList = request.method === "GET" ? criteriaCreate : null;
      const criteriaDetail = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/water-quality-criteria\/([^/]+)\/([^/]+)$/);
      if ((!match && !criteriaCreate && !criteriaDetail) || url.search || url.hash ||
          (request.method === "POST" && (!criteriaCreate || criteriaDetail || match))) return error("not_found", 404);
      const tenant = match?.[1] ?? criteriaCreate?.[1] ?? criteriaDetail?.[1];
      const resourceId = match?.[3];
      const entryId = criteriaDetail?.[2];
      const version = criteriaDetail?.[3];
      if (!validPathId(tenant, 120) || (match && (!ROUTES.has(match[2]) || !validPathId(resourceId))) ||
          (criteriaDetail && (!validPathId(entryId) || !validPathId(version, 80)))) return error("not_found", 404);
      if (!env.TENANT_API || typeof env.ACCESS_ISSUER !== "string" ||
          typeof env.ACCESS_AUDIENCE !== "string" || !env.ACCESS_AUDIENCE) {
        return error("identity_or_private_api_not_configured", 503);
      }
      let principal;
      try {
        principal = await verifyAccessToken(
          request.headers.get("Cf-Access-Jwt-Assertion"),
          { issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUDIENCE }, env,
        );
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : "";
        if (reason.startsWith("access_jwks_")) return error("identity_provider_unavailable", 503);
        if (reason === "invalid_access_issuer" || reason === "invalid_access_audience_configuration") {
          return error("identity_configuration_invalid", 503);
        }
        return error("request_not_authorized", 401);
      }
      if (!validSubject(principal.subject)) return error("request_not_authorized", 401);

      const requestId = crypto.randomUUID();
      const internalPath = match
        ? `/internal/v1/tenants/${tenant}/${match[2]}/${resourceId}`
        : criteriaDetail
          ? `/internal/v1/tenants/${tenant}/water-quality-criteria/${entryId}/${version}`
          : `/internal/v1/tenants/${tenant}/water-quality-criteria`;
      const headers = new Headers({
        "x-nova-verified-subject": principal.subject,
        "x-nova-verified-issuer": principal.issuer,
        "x-nova-verified-audience": principal.audience,
        "x-nova-gateway-issued-at": String(Math.floor(Date.now() / 1000)),
        "x-nova-request-id": requestId,
        "accept": "application/json",
      });
      try {
        headers.set("x-nova-internal-signature",
          await signEnvelope(env.INTERNAL_AUTH_SECRET, request.method, internalPath, headers));
        if (request.method === "POST") {
          const declaredLength = Number(request.headers.get("content-length") ?? "0");
          if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
              !Number.isFinite(declaredLength) || declaredLength > 65536) return error("invalid_request_body", 400);
          headers.set("content-type", "application/json");
        }
        const upstream = await env.TENANT_API.fetch(new Request(
          "https://nova-core-tenant-api.internal" + internalPath,
          { method: request.method, headers, body: request.method === "POST" ? request.body : undefined },
        ));
        return await boundedJsonResponse(upstream, requestId);
      } catch {
        return error("tenant_api_unavailable", 503);
      }
    },
  };
}
export default createGateway();
