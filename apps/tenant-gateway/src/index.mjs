import { verifyHumanAccessToken } from "./human-access-auth.mjs";
import { error, boundedJsonResponse } from "./http.mjs";

function parseAllowedOrigins(raw) {
  const origins = new Set();
  if (typeof raw !== "string") return origins;
  for (const item of raw.split(",")) {
    const candidate = item.trim();
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if ((url.protocol === "https:" || (local && url.protocol === "http:")) &&
          url.origin === candidate && !url.username && !url.password && !url.search && !url.hash) {
        origins.add(url.origin);
      }
    } catch { /* Invalid configured origins fail closed. */ }
  }
  return origins;
}

function corsResponse(response, origin, preflight) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Expose-Headers", "X-Request-Id");
  if (preflight) {
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, Idempotency-Key");
    headers.set("Access-Control-Max-Age", "600");
  }
  const vary = new Set((headers.get("Vary") || "").split(",").map(value => value.trim()).filter(Boolean));
  vary.add("Origin");
  if (preflight) {
    vary.add("Access-Control-Request-Method");
    vary.add("Access-Control-Request-Headers");
  }
  headers.set("Vary", [...vary].join(", "));
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

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

function configuredProvisioningSubjects(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 10000) return null;
  const subjects = value.split(",").map(item => item.trim());
  if (subjects.some(item => !validSubject(item)) || new Set(subjects).size !== subjects.length) return null;
  return new Set(subjects);
}

function canonicalEnvelope(method, path, headers) {
  return JSON.stringify([method, path,
    headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"),
    headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"),
    headers.get("x-nova-request-id"),
    headers.get("x-nova-body-sha256"),
    headers.get("x-nova-supabase-token-sha256"),
    headers.get("x-nova-idempotency-key")]);
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
  const handle = async (request, env) => {
      if (request.method !== "GET" && request.method !== "POST") return error("not_found", 404);
      const url = new URL(request.url);
      const tenantProvision = url.pathname === "/api/v1/tenants";
      const ownershipTransfer = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/ownership-transfer$/);
      const tenantLifecycle = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/lifecycle-actions$/);
      const tenantLifecycleEvents = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/lifecycle-events$/);
      const siteGrantChange = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/site-grants$/);
      const resourceGrantChange = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/resource-grants$/);
      const membershipChange = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/membership-actions$/);
      const membershipEvents = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/membership-events$/);
    const membershipInvitationCreate = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/membership-invitations$/);
    const membershipInvitationAccept = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/membership-invitations\/([^/]+)\/accept$/);
    const membershipInvitationRevoke = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/membership-invitations\/([^/]+)\/revoke$/);
    const identityLinkChallengeCreate = url.pathname === "/api/v1/identity-links/challenges";
    const identityLinkChallengeConsume = url.pathname.match(/^\/api\/v1\/identity-links\/challenges\/([^/]+)\/consume$/);
    const identityLinkPending = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/identity-links\/pending$/);
    const identityLinkApproved = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/identity-links\/approved$/);
    const identityLinkDecision = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/identity-links\/([^/]+)\/decision$/);
      const siteList = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites$/);
      const assetCreate = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets$/);
      const sourceRegister = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/sources$/);
      const sourceReviewerAssign = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/source-reviewers\/assign$/);
      const sourceReviewerRevoke = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/source-reviewers\/revoke$/);
      const sourceVerification = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/sources\/([^/]+)\/verification$/);
    const siteObservationList = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/observations$/);
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
      const calibrationReviewerAssign = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/calibration-reviewers\/assign$/);
      const calibrationReviewerRevoke = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/calibration-reviewers\/revoke$/);
      const calibrationVerification = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/calibrations\/([^/]+)\/verification$/);
      const sensorMappingRegister = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/sensor-source-mappings$/);
      const sensorMappingReview = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/sensor-source-mappings\/([^/]+)\/verification$/);
      const sensorMappingReviewerAssign = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/sensor-source-mapping-reviewers\/assign$/);
      const sensorMappingReviewerRevoke = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/sensor-source-mapping-reviewers\/revoke$/);
      const calibrationRegister = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/calibrations$/);
      const qualityPolicyRegister = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/measurement-quality-policies$/);
      const qualityPolicyReview = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/measurement-quality-policies\/([^/]+)\/verification$/);
      const qualityAssessment = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/observations\/([^/]+)\/measurement-quality-assessment$/);
      const labReportUpload = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/laboratory-reports$/);
      const labReportDetail = url.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/laboratory-reports\/([^/]+)$/);
      if ((tenantProvision && request.method !== "POST") || ((identityLinkChallengeCreate || identityLinkChallengeConsume || identityLinkDecision) && request.method !== "POST") || ((identityLinkPending || identityLinkApproved) && request.method !== "GET") || ((membershipInvitationCreate || membershipInvitationAccept || membershipInvitationRevoke || membershipChange || siteGrantChange || resourceGrantChange || ownershipTransfer || tenantLifecycle) && request.method !== "POST") || (tenantLifecycleEvents && request.method !== "GET") || (membershipEvents && request.method !== "GET") || (!tenantProvision && !siteList && !assetCreate && !sourceRegister && !sourceReviewerAssign && !sourceReviewerRevoke && !sourceVerification && !identityLinkChallengeCreate && !identityLinkChallengeConsume && !identityLinkPending && !identityLinkApproved && !identityLinkDecision && !siteObservationList && !membershipEvents && !membershipInvitationCreate && !membershipInvitationAccept && !membershipInvitationRevoke && !membershipChange && !siteGrantChange && !resourceGrantChange && !ownershipTransfer && !tenantLifecycle && !tenantLifecycleEvents && !match && !criteriaCreate && !criteriaDetail && !reviewerAssign && !reviewerRevoke && !reviewerList && !criteriaSubmit && !criteriaReview && !criteriaResolve && !criteriaAssess && !observationReviewerAssign && !observationReviewerRevoke && !observationVerification && !calibrationReviewerAssign && !calibrationReviewerRevoke && !calibrationVerification && !calibrationRegister && !sensorMappingRegister && !sensorMappingReview && !sensorMappingReviewerAssign && !sensorMappingReviewerRevoke && !qualityPolicyRegister && !qualityPolicyReview && !qualityAssessment && !labReportUpload && !labReportDetail) || url.search || url.hash ||
          (request.method === "POST" && (!identityLinkChallengeCreate && !identityLinkChallengeConsume && !identityLinkDecision && !criteriaCreate && !reviewerAssign && !reviewerRevoke && !criteriaSubmit && !criteriaReview && !criteriaResolve && !criteriaAssess && !observationReviewerAssign && !observationReviewerRevoke && !observationVerification && !calibrationReviewerAssign && !calibrationReviewerRevoke && !calibrationVerification && !calibrationRegister && !sensorMappingRegister && !sensorMappingReview && !sensorMappingReviewerAssign && !sensorMappingReviewerRevoke && !qualityPolicyRegister && !qualityPolicyReview && !qualityAssessment && !labReportUpload && !tenantProvision && !membershipInvitationCreate && !membershipInvitationAccept && !membershipInvitationRevoke && !membershipChange && !siteGrantChange && !resourceGrantChange && !ownershipTransfer && !tenantLifecycle || criteriaDetail || match || labReportDetail)) ||
          (request.method === "GET" && (identityLinkChallengeCreate || identityLinkChallengeConsume || identityLinkDecision || reviewerAssign || reviewerRevoke || criteriaSubmit || criteriaReview || criteriaResolve || criteriaAssess || observationReviewerAssign || observationReviewerRevoke || observationVerification || calibrationReviewerAssign || calibrationReviewerRevoke || calibrationVerification || calibrationRegister || sensorMappingRegister || sensorMappingReview || sensorMappingReviewerAssign || sensorMappingReviewerRevoke || qualityPolicyRegister || qualityPolicyReview || qualityAssessment || labReportUpload))) return error("not_found", 404);
      const tenant = tenantProvision ? null : sourceRegister?.[1] ?? sourceReviewerAssign?.[1] ?? sourceReviewerRevoke?.[1] ?? sourceVerification?.[1] ?? assetCreate?.[1] ?? siteList?.[1] ?? siteObservationList?.[1] ?? identityLinkPending?.[1] ?? identityLinkApproved?.[1] ?? identityLinkDecision?.[1] ?? membershipInvitationCreate?.[1] ?? membershipInvitationAccept?.[1] ?? membershipInvitationRevoke?.[1] ?? siteGrantChange?.[1] ?? resourceGrantChange?.[1] ?? ownershipTransfer?.[1] ?? tenantLifecycle?.[1] ?? tenantLifecycleEvents?.[1] ?? membershipChange?.[1] ?? membershipEvents?.[1] ?? match?.[1] ?? criteriaCreate?.[1] ?? criteriaDetail?.[1] ?? reviewerAssign?.[1] ?? reviewerRevoke?.[1] ?? reviewerList?.[1] ?? criteriaSubmit?.[1] ?? criteriaReview?.[1] ?? criteriaResolve?.[1] ?? criteriaAssess?.[1] ?? observationReviewerAssign?.[1] ?? observationReviewerRevoke?.[1] ?? observationVerification?.[1] ?? calibrationReviewerAssign?.[1] ?? calibrationReviewerRevoke?.[1] ?? calibrationVerification?.[1] ?? calibrationRegister?.[1] ?? sensorMappingRegister?.[1] ?? sensorMappingReview?.[1] ?? sensorMappingReviewerAssign?.[1] ?? sensorMappingReviewerRevoke?.[1] ?? qualityPolicyRegister?.[1] ?? qualityPolicyReview?.[1] ?? qualityAssessment?.[1] ?? labReportUpload?.[1] ?? labReportDetail?.[1];
      const resourceId = match?.[3];
      const entryId = criteriaDetail?.[2] ?? criteriaSubmit?.[2] ?? criteriaReview?.[2] ?? criteriaResolve?.[2] ?? criteriaAssess?.[2];
      const version = criteriaDetail?.[3] ?? criteriaSubmit?.[3] ?? criteriaReview?.[3] ?? criteriaResolve?.[3] ?? criteriaAssess?.[3];
      if ((!tenantProvision && !identityLinkChallengeCreate && !identityLinkChallengeConsume && !validPathId(tenant, 120)) || (identityLinkChallengeConsume && !validPathId(identityLinkChallengeConsume[1])) || (identityLinkDecision && !validPathId(identityLinkDecision[2])) || ((membershipInvitationAccept || membershipInvitationRevoke) && !validPathId((membershipInvitationAccept || membershipInvitationRevoke)[2])) || (match && (!ROUTES.has(match[2]) || !validPathId(resourceId))) || ((sourceRegister || sourceReviewerAssign || sourceReviewerRevoke || sourceVerification) && (!validPathId((sourceRegister || sourceReviewerAssign || sourceReviewerRevoke || sourceVerification)[1]) || !validPathId((sourceRegister || sourceReviewerAssign || sourceReviewerRevoke || sourceVerification)[2]))) || (sourceVerification && !validPathId(sourceVerification[3])) || (assetCreate && (!validPathId(assetCreate[1]) || !validPathId(assetCreate[2]))) || (siteList && !validPathId(siteList[1])) || (siteObservationList && !validPathId(siteObservationList[2])) ||
          ((criteriaDetail || criteriaSubmit || criteriaReview || criteriaResolve || criteriaAssess) && (!validPathId(entryId) || !validPathId(version, 80))) ||
          (observationVerification && !validPathId(observationVerification[2])) || (((calibrationReviewerAssign || calibrationReviewerRevoke || calibrationVerification || calibrationRegister) && (!validPathId((calibrationReviewerAssign || calibrationReviewerRevoke || calibrationVerification || calibrationRegister)[2]) || !validPathId((calibrationReviewerAssign || calibrationReviewerRevoke || calibrationVerification || calibrationRegister)[3]))) || (calibrationVerification && !validPathId(calibrationVerification[4])) || ((sensorMappingRegister || sensorMappingReview) && (!validPathId((sensorMappingRegister || sensorMappingReview)[2]) || !validPathId((sensorMappingRegister || sensorMappingReview)[3]))) || ((sensorMappingReviewerAssign || sensorMappingReviewerRevoke) && !validPathId((sensorMappingReviewerAssign || sensorMappingReviewerRevoke)[2])) || (sensorMappingReview && !validPathId(sensorMappingReview[4])) || ((qualityPolicyRegister || qualityPolicyReview) && (!validPathId((qualityPolicyRegister || qualityPolicyReview)[2]) || !validPathId((qualityPolicyRegister || qualityPolicyReview)[3]))) || (qualityPolicyReview && !validPathId(qualityPolicyReview[4])) || (qualityAssessment && !validPathId(qualityAssessment[2])) || ((labReportUpload || labReportDetail) && !validPathId((labReportUpload ?? labReportDetail)[2]))) || (labReportDetail && !validPathId(labReportDetail[3]))) return error("not_found", 404);
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
      if (tenantProvision && !configuredProvisioningSubjects(env.TENANT_PROVISIONING_SUBJECTS)?.has(principal.subject)) return error("not_found", 404);

      const requestId = crypto.randomUUID();
      const internalPath = sourceRegister
        ? "/internal/v1/tenants/" + tenant + "/sites/" + sourceRegister[2] + "/sources"
        : sourceReviewerAssign
          ? "/internal/v1/tenants/" + tenant + "/sites/" + sourceReviewerAssign[2] + "/source-reviewers/assign"
          : sourceReviewerRevoke
            ? "/internal/v1/tenants/" + tenant + "/sites/" + sourceReviewerRevoke[2] + "/source-reviewers/revoke"
            : sourceVerification
              ? "/internal/v1/tenants/" + tenant + "/sites/" + sourceVerification[2] + "/sources/" + sourceVerification[3] + "/verification"
        : assetCreate
        ? "/internal/v1/tenants/" + tenant + "/sites/" + assetCreate[2] + "/assets"
        : siteList
        ? "/internal/v1/tenants/" + tenant + "/sites"
        : siteObservationList
          ? "/internal/v1/tenants/" + tenant + "/sites/" + siteObservationList[2] + "/observations"
          : identityLinkChallengeCreate
        ? "/internal/v1/identity-links/challenges"
        : identityLinkChallengeConsume
          ? "/internal/v1/identity-links/challenges/" + identityLinkChallengeConsume[1] + "/consume"
          : identityLinkPending
            ? "/internal/v1/tenants/" + tenant + "/identity-links/pending"
            : identityLinkApproved
              ? "/internal/v1/tenants/" + tenant + "/identity-links/approved"
              : identityLinkDecision
              ? "/internal/v1/tenants/" + tenant + "/identity-links/" + identityLinkDecision[2] + "/decision"
        : tenantProvision
        ? "/internal/v1/tenants"
        : membershipInvitationCreate
          ? "/internal/v1/tenants/" + tenant + "/membership-invitations"
          : membershipInvitationAccept
            ? "/internal/v1/tenants/" + tenant + "/membership-invitations/" + membershipInvitationAccept[2] + "/accept"
            : membershipInvitationRevoke
              ? "/internal/v1/tenants/" + tenant + "/membership-invitations/" + membershipInvitationRevoke[2] + "/revoke"
          : tenantLifecycle
            ? "/internal/v1/tenants/" + tenant + "/lifecycle-actions"
          : tenantLifecycleEvents
            ? "/internal/v1/tenants/" + tenant + "/lifecycle-events"
          : ownershipTransfer
            ? "/internal/v1/tenants/" + tenant + "/ownership-transfer"
          : resourceGrantChange
            ? "/internal/v1/tenants/" + tenant + "/resource-grants"
          : siteGrantChange
            ? "/internal/v1/tenants/" + tenant + "/site-grants"
          : membershipChange
            ? "/internal/v1/tenants/" + tenant + "/membership-actions"
          : membershipEvents
            ? "/internal/v1/tenants/" + tenant + "/membership-events"
        : qualityPolicyRegister
        ? "/internal/v1/tenants/" + tenant + "/sites/" + qualityPolicyRegister[2] + "/assets/" + qualityPolicyRegister[3] + "/measurement-quality-policies"
        : qualityPolicyReview
          ? "/internal/v1/tenants/" + tenant + "/sites/" + qualityPolicyReview[2] + "/assets/" + qualityPolicyReview[3] + "/measurement-quality-policies/" + qualityPolicyReview[4] + "/verification"
          : qualityAssessment
            ? "/internal/v1/tenants/" + tenant + "/observations/" + qualityAssessment[2] + "/measurement-quality-assessment"
            : sensorMappingRegister
        ? "/internal/v1/tenants/" + tenant + "/sites/" + sensorMappingRegister[2] + "/assets/" + sensorMappingRegister[3] + "/sensor-source-mappings"
        : sensorMappingReview
          ? "/internal/v1/tenants/" + tenant + "/sites/" + sensorMappingReview[2] + "/assets/" + sensorMappingReview[3] + "/sensor-source-mappings/" + sensorMappingReview[4] + "/verification"
          : sensorMappingReviewerAssign
            ? "/internal/v1/tenants/" + tenant + "/sites/" + sensorMappingReviewerAssign[2] + "/sensor-source-mapping-reviewers/assign"
            : sensorMappingReviewerRevoke
              ? "/internal/v1/tenants/" + tenant + "/sites/" + sensorMappingReviewerRevoke[2] + "/sensor-source-mapping-reviewers/revoke"
              : calibrationReviewerAssign
        ? "/internal/v1/tenants/" + tenant + "/sites/" + calibrationReviewerAssign[2] + "/assets/" + calibrationReviewerAssign[3] + "/calibration-reviewers/assign"
        : calibrationReviewerRevoke
          ? "/internal/v1/tenants/" + tenant + "/sites/" + calibrationReviewerRevoke[2] + "/assets/" + calibrationReviewerRevoke[3] + "/calibration-reviewers/revoke"
          : calibrationVerification
            ? "/internal/v1/tenants/" + tenant + "/sites/" + calibrationVerification[2] + "/assets/" + calibrationVerification[3] + "/calibrations/" + calibrationVerification[4] + "/verification"
            : calibrationRegister
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
        if ((siteList || assetCreate || sourceRegister) && request.method === "POST") {
          const idempotencyKey = request.headers.get("Idempotency-Key");
          if (!validPathId(idempotencyKey, 160)) return error("invalid_idempotency_key", 400);
          headers.set("x-nova-idempotency-key", idempotencyKey);
        }
        const authorization = request.headers.get("authorization");
        if ((tenantProvision || identityLinkChallengeCreate || identityLinkChallengeConsume || siteList || assetCreate || siteObservationList) && authorization === null)
          return error("supabase_authorization_required", 401);
        if (authorization !== null) {
          const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]{1,16384})$/);
          if (!match) return error("invalid_supabase_authorization", 401);
          headers.set("x-nova-supabase-access-token", match[1]);
          const tokenDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1]));
          headers.set("x-nova-supabase-token-sha256",
            Array.from(new Uint8Array(tokenDigest), byte => byte.toString(16).padStart(2, "0")).join(""));
        }
        if (request.method === "POST") {
          const declaredLength = Number(request.headers.get("content-length") ?? "0");
          if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
              !Number.isFinite(declaredLength) || declaredLength > (labReportUpload ? 1500000 : 65536)) return error("invalid_request_body", 400);
          headers.set("content-type", "application/json");
        }
        const forwardedBody = request.method === "POST" ? await request.arrayBuffer() : undefined;
        if (forwardedBody && forwardedBody.byteLength > (labReportUpload ? 1500000 : 65536)) return error("invalid_request_body", 400);
        const digest = await crypto.subtle.digest("SHA-256", forwardedBody ?? new ArrayBuffer(0));
        headers.set("x-nova-body-sha256", Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""));
        headers.set("x-nova-internal-signature",
          await signEnvelope(env.INTERNAL_AUTH_SECRET, request.method, internalPath, headers));
        const upstream = await env.TENANT_API.fetch(new Request(
          "https://nova-core-tenant-api.internal" + internalPath,
          { method: request.method, headers, body: forwardedBody },
        ));
        return await boundedJsonResponse(upstream, requestId, labReportDetail ? 1500000 : undefined);
      } catch {
        return error("tenant_api_unavailable", 503);
      }
  };
  return {
    async fetch(request, env) {
      const origin = request.headers.get("origin");
      const allowed = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
      if (request.method === "OPTIONS") {
        if (!origin || !allowed.has(origin)) return error("cors_origin_not_allowed", 403);
        const requestedMethod = request.headers.get("access-control-request-method");
        const requestedHeaders = (request.headers.get("access-control-request-headers") || "")
          .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
        if (!["GET", "POST"].includes(requestedMethod) ||
            requestedHeaders.some(header => !["accept", "authorization", "content-type", "idempotency-key"].includes(header))) {
          return error("cors_preflight_not_allowed", 403);
        }
        return corsResponse(new Response(null, { status: 204 }), origin, true);
      }
      if (origin && !allowed.has(origin)) return error("cors_origin_not_allowed", 403);
      const response = await handle(request, env);
      return origin ? corsResponse(response, origin, false) : response;
    },
  };
}
export default createGateway();