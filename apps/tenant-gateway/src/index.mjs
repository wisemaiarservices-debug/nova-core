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
      const reviewerAssign = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/water-quality-criteria\/reviewers\/assign$/);
      const reviewerList = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/water-quality-criteria\/reviewers$/);
      const reviewerRevoke = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/water-quality-criteria\/reviewers\/revoke$/);
      const criteriaList = request.method === "GET" ? criteriaCreate : null;
        const criteriaDetail = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/water-quality-criteria\/(?!reviewers\/)([^/]+)\/([^/]+)$/);
      const criteriaSubmit = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/water-quality-criteria\/(?!reviewers\/)([^/]+)\/([^/]+)\/submit$/);
      const criteriaReview = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/water-quality-criteria\/(?!reviewers\/)([^/]+)\/([^/]+)\/review$/);
      const criteriaResolve = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/water-quality-criteria\/(?!reviewers\/)([^/]+)\/([^/]+)\/resolve$/);
      const criteriaAssess = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/water-quality-criteria\/(?!reviewers\/)([^/]+)\/([^/]+)\/assess$/);
      const observationReviewerAssign = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/observations\/reviewers\/assign$/);
      const observationReviewerRevoke = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/observations\/reviewers\/revoke$/);
      const observationVerification = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/observations\/([^/]+)\/verification$/);
      const calibrationRegister = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/calibrations$/);
      const labReportUpload = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/laboratory-reports$/);
      const labReportDetail = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/laboratory-reports\/([^/]+)$/);
      if ((!match && !criteriaCreate && !criteriaDetail && !reviewerAssign && !reviewerRevoke && !reviewerList && !criteriaSubmit && !criteriaReview && !criteriaResolve && !criteriaAssess && !observationReviewerAssign && !observationReviewerRevoke && !observationVerification && !calibrationRegister && !labReportUpload && !labReportDetail) || url.search || url.hash ||
          (request.method === "POST" && (!criteriaCreate && !reviewerAssign && !reviewerRevoke && !criteriaSubmit && !criteriaReview && !criteriaResolve && !criteriaAssess && !observationReviewerAssign && !observationReviewerRevoke && !observationVerification && !calibrationRegister && !labReportUpload || criteriaDetail || match || labReportDetail)) ||
          (request.method === "GET" && (reviewerAssign || reviewerRevoke || criteriaSubmit || criteriaReview || criteriaResolve || criteriaAssess || observationReviewerAssign || observationReviewerRevoke || observationVerification || calibrationRegister || labReportUpload))) return error("not_found", 404);
      const tenant = match?.[1] ?? criteriaCreate?.[1] ?? criteriaDetail?.[1] ?? reviewerAssign?.[1] ?? reviewerRevoke?.[1] ?? reviewerList?.[1] ?? criteriaSubmit?.[1] ?? criteriaReview?.[1] ?? criteriaResolve?.[1] ?? criteriaAssess?.[1] ?? observationReviewerAssign?.[1] ?? observationReviewerRevoke?.[1] ?? observationVerification?.[1] ?? calibrationRegister?.[1] ?? labReportUpload?.[1] ?? labReportDetail?.[1];
      const resourceId = match?.[3];
      const entryId = criteriaDetail?.[2] ?? criteriaSubmit?.[2] ?? criteriaReview?.[2] ?? criteriaResolve?.[2] ?? criteriaAssess?.[2];
      const version = criteriaDetail?.[3] ?? criteriaSubmit?.[3] ?? criteriaReview?.[3] ?? criteriaResolve?.[3] ?? criteriaAssess?.[3];
      if (!validPathId(tenant, 120) || (match && (!ROUTES.has(match[2]) || !validPathId(resourceId))) ||
          ((criteriaDetail || criteriaSubmit || criteriaReview || criteriaResolve || criteriaAssess) && (!validPathId(entryId) || !validPathId(version, 80))) ||
          (observationVerification && !validPathId(observationVerification[2])) || ((calibrationRegister && (!validPathId(calibrationRegister[2]) || !validPathId(calibrationRegister[3]))) || ((labReportUpload || labReportDetail) && !validPathId((labReportUpload ?? labReportDetail)[2]))) || (labReportDetail && !validPathId(labReportDetail[3]))) return error("not_found", 404);
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
      const internalPath = calibrationRegister
        ? "/internal/v1/tenants/" + tenant + "/sites/" + calibrationRegister[2] + "/assets/" + calibrationRegister[3] + "/calibrations"
        : labReportUpload
        ? "/internal/v1/tenants/" + tenant + "/sites/" + labReportUpload[2] + "/laboratory-reports"
        : labReportDetail
          ? "/internal/v1/tenants/" + tenant + "/sites/" + labReportDetail[2] + "/laboratory-reports/" + labReportDetail[3]
          : observationReviewerAssign
        ? `/internal/v1/tenants/${tenant}/observations/reviewers/assign`
        : observationReviewerRevoke
          ? `/internal/v1/tenants/${tenant}/observations/reviewers/revoke`
          : observationVerification
            ? `/internal/v1/tenants/${tenant}/observations/${observationVerification[2]}/verification`
            : match
        ? `/internal/v1/tenants/${tenant}/${match[2]}/${resourceId}`
        : criteriaDetail
          ? `/internal/v1/tenants/${tenant}/water-quality-criteria/${entryId}/${version}`
          : reviewerAssign
          ? `/internal/v1/tenants/${tenant}/water-quality-criteria/reviewers/assign`
          : reviewerRevoke
            ? `/internal/v1/tenants/${tenant}/water-quality-criteria/reviewers/revoke`
            : reviewerList
              ? `/internal/v1/tenants/${tenant}/water-quality-criteria/reviewers`
              : criteriaSubmit
                ? `/internal/v1/tenants/${tenant}/water-quality-criteria/${criteriaSubmit[2]}/${criteriaSubmit[3]}/submit`
                : criteriaReview
                  ? `/internal/v1/tenants/${tenant}/water-quality-criteria/${criteriaReview[2]}/${criteriaReview[3]}/review`
                  : criteriaResolve
                    ? `/internal/v1/tenants/${tenant}/water-quality-criteria/${criteriaResolve[2]}/${criteriaResolve[3]}/resolve`
                    : criteriaAssess
                      ? `/internal/v1/tenants/${tenant}/water-quality-criteria/${criteriaAssess[2]}/${criteriaAssess[3]}/assess`
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
              !Number.isFinite(declaredLength) || declaredLength > (labReportUpload ? 1500000 : 65536)) return error("invalid_request_body", 400);
          headers.set("content-type", "application/json");
        }
        const forwardedBody = request.method === "POST" ? await request.arrayBuffer() : undefined;
        if (forwardedBody && forwardedBody.byteLength > (labReportUpload ? 1500000 : 65536)) return error("invalid_request_body", 400);
        const upstream = await env.TENANT_API.fetch(new Request(
          "https://nova-core-tenant-api.internal" + internalPath,
          { method: request.method, headers, body: forwardedBody },
        ));
        return await boundedJsonResponse(upstream, requestId, labReportDetail ? 1500000 : undefined);
      } catch {
        return error("tenant_api_unavailable", 503);
      }
    },
  };
}
export default createGateway();
