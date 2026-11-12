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
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
export default {
  async fetch(request, env) {
    if (request.method !== "GET") return error("not_found", 404);
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/(sites|assets|sources|observations|audit-events)\/([^/]+)$/);
    if (!match || url.search || url.hash) return error("not_found", 404);
    const [, tenant, routeType, resourceId] = match;
    if (!validPathId(tenant, 120) || !ROUTES.has(routeType) || !validPathId(resourceId)) return error("not_found", 404);
    if (!env.TENANT_API || typeof env.ACCESS_ISSUER !== "string" ||
        typeof env.ACCESS_AUDIENCE !== "string" || !env.ACCESS_AUDIENCE) {
      return error("identity_or_private_api_not_configured", 503);
    }
    let principal;
    try {
      principal = await verifyHumanAccessToken(
        request.headers.get("Cf-Access-Jwt-Assertion"),
        { issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUDIENCE },
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
    const internalPath = `/internal/v1/tenants/${tenant}/${routeType}/${resourceId}`;
    // Construct a fresh request: no caller-supplied identity/trust headers,
    // cookies, query parameters, body, or arbitrary upstream URL are forwarded.
    const headers = new Headers({
      "x-nova-verified-subject": principal.subject,
      "x-nova-verified-issuer": principal.issuer,
      "x-nova-verified-audience": principal.audience,
      "x-nova-gateway-issued-at": String(Math.floor(Date.now() / 1000)),
      "x-nova-request-id": requestId,
      "accept": "application/json",
    });
    try {
      const upstream = await env.TENANT_API.fetch(new Request(
        "https://nova-core-tenant-api.internal" + internalPath, { method: "GET", headers },
      ));
      return await boundedJsonResponse(upstream, requestId);
    } catch {
      return error("tenant_api_unavailable", 503);
    }
  },
};
