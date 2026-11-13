import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, createHmac, createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

const base = "http://127.0.0.1:8787";
const secret = "local-ci-only-secret-not-for-any-deployment";
const issuer = "https://nova-ci.cloudflareaccess.com";
const audience = "nova-ci-test-audience";
const privateKey = createPrivateKey(await readFile("../tenant-gateway/test/fixtures/nova-local-ci-private.pem"));
const child = spawn("npx", ["--yes", "wrangler@4.13.2", "dev", "--local",
  "-c", "../tenant-gateway/wrangler.local-test.toml",
  "-c", "wrangler.d1-test.toml",
  "--ip", "127.0.0.1", "--port", "8787",
  "--persist-to", "./.wrangler-d1-test"], { stdio: "ignore" });

function b64url(value) { return Buffer.from(value).toString("base64url"); }
function accessToken(subject = "ci-human-subject") {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "nova-local-ci-key" }));
  const claims = b64url(JSON.stringify({ iss: issuer, aud: [audience], sub: subject, iat: now - 2, exp: now + 300 }));
  const input = head + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}
async function throughGateway(path, token = accessToken(), extraHeaders = {}, method = "GET", body = undefined) {
  const response = await fetch(base + path, {
    method, headers: { "Cf-Access-Jwt-Assertion": token, ...extraHeaders },
    body,
  });
  return { response, body: await response.json() };
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Wrangler multi-Worker local runtime exited before readiness");
    try {
      const result = await fetch(base + "/not-a-route");
      if (result.status === 404) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Wrangler multi-Worker local runtime did not become ready");
}
try {
  await ready();
  const sitePath = "/api/v1/tenants/tenant-http-a/sites/site-http-a";
  const allowed = await throughGateway(sitePath);
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.data.id, "site-http-a");
  assert.equal(allowed.body.data.tenant_id, "tenant-http-a");

  const deniedGrant = await throughGateway("/api/v1/tenants/tenant-http-a/sites/site-http-b");
  assert.equal(deniedGrant.response.status, 404);

  const deniedTenant = await throughGateway("/api/v1/tenants/tenant-http-b/sites/site-http-b");
  assert.equal(deniedTenant.response.status, 404);

  const invalidIdentity = await throughGateway(sitePath, "not.a.valid.jwt");
  assert.equal(invalidIdentity.response.status, 401);

  const criteriaList = await throughGateway("/api/v1/tenants/tenant-http-a/water-quality-criteria");
  assert.equal(criteriaList.response.status, 200, JSON.stringify(criteriaList.body));
  assert.equal(criteriaList.body.data.length, 1);
  assert.equal(criteriaList.body.data[0].id, "criteria-http-a");
  assert.equal(criteriaList.body.data[0].entry.criteria[0].parameter, "ec");

  const criteriaVersion = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-a/1.0");
  assert.equal(criteriaVersion.response.status, 200, JSON.stringify(criteriaVersion.body));
  assert.equal(criteriaVersion.body.data.id, "criteria-http-a");
  assert.equal(criteriaVersion.body.data.version, "1.0");

  const criteriaCrossTenant = await throughGateway(
    "/api/v1/tenants/tenant-http-b/water-quality-criteria");
  assert.equal(criteriaCrossTenant.response.status, 404);
  const criteriaUnknownVersion = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-a/9.9");
  assert.equal(criteriaUnknownVersion.response.status, 404);

  const draftEntry = {
    id: "criteria-http-draft", jurisdiction: "TN", title: "CI draft fixture only",
    version: "1.0.0", published_on: "2026-01-01", effective_from: "2026-02-01",
    authority: { name: "CI fixture source", source_evidence_ref: "fixture:source",
      document_digest: "sha256:" + "c".repeat(64) },
    scope: { tenant_id: "tenant-http-a", site_id: "site-http-a",
      crop_ids: ["olive"], irrigation_methods: ["drip"],
      intended_uses: ["agricultural_irrigation"] },
    criteria: [{ parameter: "ec", unit: "dS/m", operator: "max", value: 2,
      reference_clause: "fixture clause 1", evidence_ref: "fixture:clause-1" }],
    review: { status: "draft", approvals: [] },
  };
  const draftCreated = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria", accessToken(),
    { "content-type": "application/json" }, "POST", JSON.stringify({ entry: draftEntry }));
  assert.equal(draftCreated.response.status, 201, JSON.stringify(draftCreated.body));
  assert.equal(draftCreated.body.data.id, "criteria-http-draft");
  assert.equal(draftCreated.body.data.created_by_subject, "ci-human-subject");

  const draftListed = await throughGateway("/api/v1/tenants/tenant-http-a/water-quality-criteria");
  assert.equal(draftListed.response.status, 200, JSON.stringify(draftListed.body));
  assert.equal(draftListed.body.data.some(row => row.id === "criteria-http-draft" && row.entry.review.status === "draft"), true);

  const regulatoryReviewer = {
    reviewer_subject: "ci-regulatory-reviewer", reviewer_role: "regulatory_reviewer",
    jurisdiction: "TN", evidence_ref: "fixture:regulatory-appointment",
  };
  const domainReviewer = {
    reviewer_subject: "ci-domain-reviewer", reviewer_role: "domain_expert",
    jurisdiction: "TN", evidence_ref: "fixture:domain-appointment",
  };
  for (const reviewer of [regulatoryReviewer, domainReviewer]) {
    const assigned = await throughGateway(
      "/api/v1/tenants/tenant-http-a/water-quality-criteria/reviewers/assign",
      accessToken(), { "content-type": "application/json" }, "POST", JSON.stringify(reviewer));
    assert.equal(assigned.response.status, 201, JSON.stringify(assigned.body));
  }
  const submitted = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-draft/1.0.0/submit",
    accessToken(), { "content-type": "application/json" }, "POST", "{}");
  assert.equal(submitted.response.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.data.status, "submitted_for_review");

  const reviewerContext = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-draft/1.0.0",
    accessToken(regulatoryReviewer.reviewer_subject));
  assert.equal(reviewerContext.response.status, 200, JSON.stringify(reviewerContext.body));
  assert.equal(reviewerContext.body.data.lifecycle.status, "submitted_for_review");
  assert.equal(reviewerContext.body.data.approvals.length, 0);
  assert.equal(reviewerContext.body.data.legal_status, "not_verified");

  const resolverContext = { tenant_id: "tenant-http-a", site_id: "site-http-a",
    jurisdiction: "TN", crop_id: "olive", irrigation_method: "drip",
    intended_use: "agricultural_irrigation" };
  const pendingResolution = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-draft/1.0.0/resolve",
    accessToken(), { "content-type": "application/json" }, "POST",
    JSON.stringify({ context: resolverContext, sampled_at: "2026-05-10T10:00:00Z" }));
  assert.equal(pendingResolution.response.status, 200);
  assert.equal(pendingResolution.body.data.status, "not_assessed");
  assert.equal(pendingResolution.body.data.reason, "registry_entry_not_approved");

  const unassignedContext = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-draft/1.0.0",
    accessToken("unassigned-reviewer"));
  assert.equal(unassignedContext.response.status, 404);

  const firstApproval = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-draft/1.0.0/review",
    accessToken(regulatoryReviewer.reviewer_subject), { "content-type": "application/json" }, "POST",
    JSON.stringify({ reviewer_role: regulatoryReviewer.reviewer_role, decision: "approve",
      evidence_ref: "fixture:regulatory-review" }));
  assert.equal(firstApproval.response.status, 201, JSON.stringify(firstApproval.body));
  assert.equal(firstApproval.body.data.status, "submitted_for_review");

  const secondApproval = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-draft/1.0.0/review",
    accessToken(domainReviewer.reviewer_subject), { "content-type": "application/json" }, "POST",
    JSON.stringify({ reviewer_role: domainReviewer.reviewer_role, decision: "approve",
      evidence_ref: "fixture:domain-review" }));
  assert.equal(secondApproval.response.status, 201, JSON.stringify(secondApproval.body));
  assert.equal(secondApproval.body.data.status, "approved");

  const approvedResolution = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-draft/1.0.0/resolve",
    accessToken(), { "content-type": "application/json" }, "POST",
    JSON.stringify({ context: resolverContext, sampled_at: "2026-05-10T10:00:00Z" }));
  assert.equal(approvedResolution.response.status, 200, JSON.stringify(approvedResolution.body));
  assert.equal(approvedResolution.body.data.status, "approved_entry_scope_match");
  assert.equal(approvedResolution.body.data.lifecycle_status, "approved");
  assert.equal(approvedResolution.body.data.operational_decision, "not_authorized");

  const observationReviewer = {
    site_id: "site-http-a", reviewer_subject: "ci-measurement-reviewer",
    evidence_ref: "fixture:measurement-reviewer-appointment",
  };
  const observationReviewerAssigned = await throughGateway(
    "/api/v1/tenants/tenant-http-a/observations/reviewers/assign",
    accessToken(), { "content-type": "application/json" }, "POST", JSON.stringify(observationReviewer));
  assert.equal(observationReviewerAssigned.response.status, 201,
    JSON.stringify(observationReviewerAssigned.body));
  assert.equal(observationReviewerAssigned.body.data.reviewer_role, "measurement_reviewer");

  const selfAssignment = await throughGateway(
    "/api/v1/tenants/tenant-http-a/observations/reviewers/assign",
    accessToken(), { "content-type": "application/json" }, "POST",
    JSON.stringify({ ...observationReviewer, reviewer_subject: "ci-human-subject" }));
  assert.equal(selfAssignment.response.status, 400);

  const verifiedObservation = await throughGateway(
    "/api/v1/tenants/tenant-http-a/observations/obs-http-verified/verification",
    accessToken("ci-measurement-reviewer"), { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "verify", evidence_ref: "fixture:physical-inspection" }));
  assert.equal(verifiedObservation.response.status, 201, JSON.stringify(verifiedObservation.body));
  assert.equal(verifiedObservation.body.data.verification_status, "verified");

  const verifiedSampleAssessment = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-draft/1.0.0/assess",
    accessToken(), { "content-type": "application/json" }, "POST",
    JSON.stringify({ context: resolverContext, samples: [{
      id: "ci-verified-measured-sample", parameter: "ec", value: 1.5, unit: "dS/m",
      sampled_at: "2026-05-10T10:00:00Z",
      provenance: { source_type: "measured", method: "field_meter", evidence_ref: "observation:obs-http-verified" },
    }] }));
  assert.equal(verifiedSampleAssessment.response.status, 200, JSON.stringify(verifiedSampleAssessment.body));
  assert.equal(verifiedSampleAssessment.body.data.results[0].status, "within_declared_criterion");
  assert.equal(verifiedSampleAssessment.body.data.results[0].sample_provenance.verification_status,
    "matched_to_verified_core_observation");

  const revokedObservation = await throughGateway(
    "/api/v1/tenants/tenant-http-a/observations/obs-http-verified/verification",
    accessToken("ci-measurement-reviewer"), { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "revoke", evidence_ref: "fixture:withdrawn-inspection", reason: "CI revocation check" }));
  assert.equal(revokedObservation.response.status, 201, JSON.stringify(revokedObservation.body));
  assert.equal(revokedObservation.body.data.verification_status, "unverified");

  const revokedSampleAssessment = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-draft/1.0.0/assess",
    accessToken(), { "content-type": "application/json" }, "POST",
    JSON.stringify({ context: resolverContext, samples: [{
      id: "ci-revoked-measured-sample", parameter: "ec", value: 1.5, unit: "dS/m",
      sampled_at: "2026-05-10T10:00:00Z",
      provenance: { source_type: "measured", method: "field_meter", evidence_ref: "observation:obs-http-verified" },
    }] }));
  assert.equal(revokedSampleAssessment.response.status, 200);
  assert.equal(revokedSampleAssessment.body.data.results[0].status, "not_assessed");
  assert.equal(revokedSampleAssessment.body.data.results[0].reason, "persisted_observation_not_verified");

  const serviceIdentityAssignment = await throughGateway(
    "/api/v1/tenants/tenant-http-a/observations/reviewers/assign",
    accessToken(), { "content-type": "application/json" }, "POST",
    JSON.stringify({ ...observationReviewer, reviewer_subject: "neoagro-ingestion-service",
      evidence_ref: "fixture:service-identity-assignment" }));
  assert.equal(serviceIdentityAssignment.response.status, 201);
  const selfReviewByIngestionIdentity = await throughGateway(
    "/api/v1/tenants/tenant-http-a/observations/obs-http-verified/verification",
    accessToken("neoagro-ingestion-service"), { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "verify", evidence_ref: "fixture:self-review-attempt" }));
  assert.equal(selfReviewByIngestionIdentity.response.status, 409);
  assert.equal(selfReviewByIngestionIdentity.body.error, "observation_submitter_independence_not_established");

  const crossTenantVerification = await throughGateway(
    "/api/v1/tenants/tenant-http-b/observations/obs-http-verified/verification",
    accessToken("ci-measurement-reviewer"), { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "verify", evidence_ref: "fixture:cross-tenant-attempt" }));
  assert.equal(crossTenantVerification.response.status, 404);

  const sampleAssessment = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-draft/1.0.0/assess",
    accessToken(), { "content-type": "application/json" }, "POST",
    JSON.stringify({ context: resolverContext, samples: [
      { id: "ci-sample-within", parameter: "ec", value: 1.5, unit: "dS/m", sampled_at: "2026-05-10T10:00:00Z", provenance: { source_type: "synthetic", method: "local_ci_fixture", evidence_ref: "fixture:within" } },
      { id: "ci-sample-outside", parameter: "ec", value: 3, unit: "dS/m", sampled_at: "2026-05-10T10:00:00Z", provenance: { source_type: "synthetic", method: "local_ci_fixture", evidence_ref: "fixture:outside" } },
    ] }));
  assert.equal(sampleAssessment.response.status, 200, JSON.stringify(sampleAssessment.body));
  assert.equal(sampleAssessment.body.data.status, "partial_criteria_comparison");
  assert.equal(sampleAssessment.body.data.results[0].status, "not_assessed");
  assert.equal(sampleAssessment.body.data.results[0].reason, "synthetic_sample_not_eligible_for_field_assessment");
  assert.equal(sampleAssessment.body.data.results[1].status, "not_assessed");
  assert.equal(sampleAssessment.body.data.results[1].reason, "synthetic_sample_not_eligible_for_field_assessment");
  assert.equal(sampleAssessment.body.data.operational_decision, "not_authorized");

  const unverifiedObservationAssessment = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/criteria-http-draft/1.0.0/assess",
    accessToken(), { "content-type": "application/json" }, "POST",
    JSON.stringify({ context: resolverContext, samples: [{
      id: "ci-measured-sample", parameter: "ec", value: 1.5, unit: "dS/m",
      sampled_at: "2026-05-10T10:00:00Z",
      provenance: { source_type: "measured", method: "field_meter", evidence_ref: "observation:missing-ci-observation" },
    }] }));
  assert.equal(unverifiedObservationAssessment.response.status, 200,
    JSON.stringify(unverifiedObservationAssessment.body));
  assert.equal(unverifiedObservationAssessment.body.data.results[0].status, "not_assessed");
  assert.equal(unverifiedObservationAssessment.body.data.results[0].reason,
    "persisted_observation_not_found_in_site_scope");

  const reviewer = {
    reviewer_subject: "independent-reviewer@example.test",
    reviewer_role: "regulatory_reviewer", jurisdiction: "TN",
    evidence_ref: "fixture:reviewer-appointment",
  };
  const assigned = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/reviewers/assign",
    accessToken(), { "content-type": "application/json" }, "POST", JSON.stringify(reviewer));
  assert.equal(assigned.response.status, 201, JSON.stringify(assigned.body));
  assert.equal(assigned.body.data.status, "active");
  const reviewerList = await throughGateway("/api/v1/tenants/tenant-http-a/water-quality-criteria/reviewers");
  assert.equal(reviewerList.response.status, 200, JSON.stringify(reviewerList.body));
  assert.equal(reviewerList.body.data.reviewers.some(row =>
    row.reviewer_subject === reviewer.reviewer_subject && row.status === "active"), true);
  assert.equal(reviewerList.body.data.events.some(row => row.event_type === "assigned" &&
    row.reviewer_subject === reviewer.reviewer_subject), true);

  const revoked = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/reviewers/revoke",
    accessToken(), { "content-type": "application/json" }, "POST",
    JSON.stringify({ ...reviewer, evidence_ref: "fixture:reviewer-revocation", reason: "CI revocation fixture" }));
  assert.equal(revoked.response.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.data.status, "revoked");
  const reviewerHistory = await throughGateway("/api/v1/tenants/tenant-http-a/water-quality-criteria/reviewers");
  assert.equal(reviewerHistory.response.status, 200);
  assert.equal(reviewerHistory.body.data.reviewers.find(row =>
    row.reviewer_subject === reviewer.reviewer_subject).status, "revoked");
  assert.equal(reviewerHistory.body.data.events.filter(row =>
    row.reviewer_subject === reviewer.reviewer_subject).length, 2);

  // Register an actual bounded PDF byte sequence; the API computes SHA-256
  // from those bytes and returns the same immutable record on an exact retry.
  const labReportBytes = Buffer.from("%PDF-1.4\\nNOVA local CI lab report\\n%%EOF");
  const labReportPayload = {
    file_name: "ci-laboratory-report.pdf", media_type: "application/pdf",
    laboratory_name: "CI fixture laboratory", report_number: "CI-RPT-001",
    sample_reference: "ci-sample-001", issued_at: "2026-10-01T10:30:00Z",
    document_base64: labReportBytes.toString("base64"),
  };
  const labReportPath = "/api/v1/tenants/tenant-http-a/sites/site-http-a/laboratory-reports";
  const labReport = await throughGateway(labReportPath, accessToken(),
    { "content-type": "application/json" }, "POST", JSON.stringify(labReportPayload));
  assert.equal(labReport.response.status, 201, JSON.stringify(labReport.body));
  assert.equal(labReport.body.data.sha256, createHash("sha256").update(labReportBytes).digest("hex"));
  assert.equal(labReport.body.data.byte_length, labReportBytes.length);
  assert.equal(labReport.body.data.verification_status, "registered_unverified");
  const labReportReplay = await throughGateway(labReportPath, accessToken(),
    { "content-type": "application/json" }, "POST", JSON.stringify(labReportPayload));
  assert.equal(labReportReplay.response.status, 200, JSON.stringify(labReportReplay.body));
  assert.equal(labReportReplay.body.data.id, labReport.body.data.id);
  assert.equal(labReportReplay.body.data.idempotent, true);
  const labReportRead = await throughGateway(labReportPath + "/" + labReport.body.data.id);
  assert.equal(labReportRead.response.status, 200, JSON.stringify(labReportRead.body));
  assert.equal(Buffer.from(labReportRead.body.data.document_base64, "base64").compare(labReportBytes), 0);
  assert.equal(labReportRead.body.data.sha256, labReport.body.data.sha256);
  const labReportCrossTenant = await throughGateway(
    "/api/v1/tenants/tenant-http-b/sites/site-http-b/laboratory-reports/" + labReport.body.data.id);
  assert.equal(labReportCrossTenant.response.status, 404);
  // A calibration record stays unverified until a separate assigned reviewer acts.
  const calibrationReviewer = { site_id: "site-http-a",
    reviewer_subject: "ci-calibration-reviewer", evidence_ref: "fixture:calibration-reviewer-appointment" };
  const reviewerAssigned = await throughGateway(
    "/api/v1/tenants/tenant-http-a/observations/reviewers/assign", accessToken(),
    { "content-type": "application/json" }, "POST", JSON.stringify(calibrationReviewer));
  assert.equal(reviewerAssigned.response.status, 201, JSON.stringify(reviewerAssigned.body));
  const calibrationPayload = { instrument_serial: "CI-SENSOR-001", metric: "ec", unit: "dS/m",
    calibration_method: "laboratory", calibration_standard: "CI EC reference standard",
    calibrated_at: "2026-05-01T10:00:00Z", valid_until: "2027-05-01T10:00:00Z",
    range_min: 0, range_max: 2, uncertainty: 0.05,
    evidence_ref: "lab-report:" + labReport.body.data.id };
  const calibrationPath = "/api/v1/tenants/tenant-http-a/sites/site-http-a/sources/source-http-a/calibrations";
  const calibration = await throughGateway(calibrationPath, accessToken(),
    { "content-type": "application/json" }, "POST", JSON.stringify(calibrationPayload));
  assert.equal(calibration.response.status, 201, JSON.stringify(calibration.body));
  assert.equal(calibration.body.data.status, "unverified");
  const calibrationDetail = await throughGateway(calibrationPath + "/" + calibration.body.data.id, accessToken());
  assert.equal(calibrationDetail.response.status, 200, JSON.stringify(calibrationDetail.body));
  assert.equal(calibrationDetail.body.data.events[0].event_type, "registered");
  assert.equal(calibrationDetail.body.data.instrument_serial, "CI-SENSOR-001");
  const calibrationReviewPath = calibrationPath + "/" + calibration.body.data.id + "/review";
  const calibrationVerified = await throughGateway(calibrationReviewPath,
    accessToken("ci-calibration-reviewer"), { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "verify", evidence_ref: "inspection:calibration-review" }));
  assert.equal(calibrationVerified.response.status, 201, JSON.stringify(calibrationVerified.body));
  assert.equal(calibrationVerified.body.data.status, "verified");
  const measurementQualityPath = "/api/v1/tenants/tenant-http-a/observations/obs-http-verified/measurement-quality";
  const measurementQuality = await throughGateway(measurementQualityPath, accessToken());
  assert.equal(measurementQuality.response.status, 200, JSON.stringify(measurementQuality.body));
  assert.equal(measurementQuality.body.data.status, "covered_by_verified_calibration");
  assert.equal(measurementQuality.body.data.observation_verification_status, "unverified");
  const calibrationRevoked = await throughGateway(calibrationReviewPath,
    accessToken("ci-calibration-reviewer"), { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "revoke", evidence_ref: "inspection:calibration-withdrawal",
      reason: "Calibration certificate withdrawn in CI fixture" }));
  assert.equal(calibrationRevoked.response.status, 201, JSON.stringify(calibrationRevoked.body));
  const qualityAfterRevocation = await throughGateway(measurementQualityPath, accessToken());
  assert.equal(qualityAfterRevocation.response.status, 200);
  assert.equal(qualityAfterRevocation.body.data.status, "not_assessed");
  assert.equal(qualityAfterRevocation.body.data.reason, "calibration_pending_human_review");
  const crossTenantQuality = await throughGateway(
    "/api/v1/tenants/tenant-http-b/observations/obs-http-verified/measurement-quality");
  assert.equal(crossTenantQuality.response.status, 404);

  const forgedHeaders = await throughGateway(sitePath, accessToken(), {
    "x-nova-verified-subject": "attacker-subject",
    "x-nova-verified-issuer": "https://attacker.example",
    cookie: "session=must-not-cross-trust-boundary",
  });
  assert.equal(forgedHeaders.response.status, 200);
  assert.equal(forgedHeaders.body.data.id, "site-http-a");

  // Exercise the real persistence helper through a test-only entrypoint backed
  // by the same disposable local D1 used by the Service Binding integration.
  function configurationPayload(label, tenantId = "tenant-http-a", siteId = "site-http-a") {
    return { tenant: { tenant_id: tenantId }, site: { site_id: siteId, timezone: "Africa/Tunis",
      crops: [{ id: "crop-1", species: label }], irrigation_systems: [{ id: "irrigation-1", method: "unknown" }],
      energy_systems: [{ id: "energy-1", type: "unknown" }] } };
  }
  async function writeConfiguration(key, requestId, payload, tenantId = "tenant-http-a", siteId = "site-http-a") {
    const response = await fetch(base + "/__ci/configuration-write", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({
        tenantId, siteId,
        requestId, schemaId: "nova.client-config.v1", payload,
      }),
    });
    return { response, body: await response.json() };
  }
  async function configurationState(key, tenant = "tenant-http-a") {
    const response = await fetch(base + "/__ci/configuration-write-state?key=" + encodeURIComponent(key) + "&tenant=" + encodeURIComponent(tenant));
    assert.equal(response.status, 200);
    return response.json();
  }

  const invalidPayload = configurationPayload("invalid");
  invalidPayload.site.boundary = { type: "Polygon", coordinates: [] };
  const invalidWrite = await writeConfiguration("ci-invalid-domain-key", "req-invalid-domain", invalidPayload);
  assert.equal(invalidWrite.response.status, 400);
  assert.equal(invalidWrite.body.error, "configuration_domain_invalid");
  const invalidState = await configurationState("ci-invalid-domain-key");
  assert.equal(invalidState.idempotency.length, 0);
  assert.equal(invalidState.configurations.length, 0);
  assert.equal(invalidState.events.length, 0);
  assert.equal(invalidState.audits.length, 0);

  const firstPayload = configurationPayload("olive");
  const created = await writeConfiguration("ci-config-key-1", "req-config-1", firstPayload);
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.data.replayed, false);
  assert.equal(created.body.data.configuration_version, "v1");
  const firstId = created.body.data.configuration_id;

  const replay = await writeConfiguration("ci-config-key-1", "req-config-replay", firstPayload);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.data.replayed, true);
  assert.equal(replay.body.data.configuration_id, firstId);
  assert.equal(replay.body.data.configuration_version, "v1");

  const second = await writeConfiguration("ci-config-key-2", "req-config-2",
    configurationPayload("citrus"));
  assert.equal(second.response.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.data.configuration_version, "v2");

  // Two simultaneous requests with the same idempotency key must commit once
  // and return the same immutable configuration result to both callers.
  const concurrentPayload = configurationPayload("date-palm");
  const concurrent = await Promise.all([
    writeConfiguration("ci-config-key-concurrent", "req-config-concurrent-a", concurrentPayload),
    writeConfiguration("ci-config-key-concurrent", "req-config-concurrent-b", concurrentPayload),
  ]);
  assert.equal(concurrent.every(item => item.response.status === 200), true,
    JSON.stringify(concurrent.map(item => item.body)));
  assert.equal(concurrent[0].body.data.configuration_id, concurrent[1].body.data.configuration_id);
  assert.deepEqual(concurrent.map(item => item.body.data.replayed).sort(), [false, true]);
  assert.equal(concurrent[0].body.data.configuration_version, "v3");
  assert.equal(concurrent[1].body.data.configuration_version, "v3");

  // Distinct concurrent keys must still receive distinct contiguous versions.
  const parallelVersions = await Promise.all([
    writeConfiguration("ci-config-key-parallel-a", "req-config-parallel-a",
      configurationPayload("fig")),
    writeConfiguration("ci-config-key-parallel-b", "req-config-parallel-b",
      configurationPayload("almond")),
  ]);
  assert.equal(parallelVersions.every(item => item.response.status === 200), true,
    JSON.stringify(parallelVersions.map(item => item.body)));
  assert.deepEqual(
    parallelVersions.map(item => item.body.data.configuration_version).sort(),
    ["v4", "v5"],
  );
  assert.notEqual(parallelVersions[0].body.data.configuration_id,
    parallelVersions[1].body.data.configuration_id);

  // The same verified subject cannot write to another tenant merely by
  // substituting tenant/site IDs in the request body.
  const crossTenant = await writeConfiguration("ci-cross-tenant-key", "req-cross-tenant",
    configurationPayload("unauthorized", "tenant-http-b", "site-http-b"), "tenant-http-b", "site-http-b");
  assert.equal(crossTenant.response.status, 403);
  assert.equal(crossTenant.body.error, "configuration_authorization_denied");
  const tenantBState = await configurationState("ci-cross-tenant-key", "tenant-http-b");
  assert.equal(tenantBState.idempotency.length, 0);
  assert.equal(tenantBState.configurations.length, 0);
  assert.equal(tenantBState.events.length, 0);
  assert.equal(tenantBState.audits.length, 0);

  const conflict = await writeConfiguration("ci-config-key-1", "req-config-conflict",
    configurationPayload("different-payload"));
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error, "configuration_idempotency_conflict");

  const committed = await configurationState("ci-config-key-1");
  assert.equal(committed.idempotency.length, 1);
  assert.equal(committed.idempotency[0].status, "completed");
  assert.deepEqual(committed.configurations.map(row => row.configuration_version), ["v1", "v2", "v3", "v4", "v5"]);
  assert.equal(committed.events.length, 5);
  assert.equal(committed.events.every(row => row.event_type === "submitted_for_review"), true);
  assert.equal(committed.audits.length, 5);
  assert.equal(committed.audits.every(row => row.action === "configuration.created_for_review"), true);

  const failed = await writeConfiguration("ci-config-key-fail", "req-fail",
    configurationPayload("must-rollback"));
  assert.notEqual(failed.response.status, 200);
  const rolledBack = await configurationState("ci-config-key-fail");
  assert.equal(rolledBack.idempotency.length, 0);
  assert.equal(rolledBack.configurations.length, 5);
  assert.equal(rolledBack.events.length, 5);
  assert.equal(rolledBack.audits.length, 5);

  console.log("Local D1 configuration persistence integration passed: transactional authorization, v1–v5 sequencing under concurrent distinct keys, exact replay, concurrent idempotency race, conflicting-key rejection, audit/review consistency and late-statement rollback");
  console.log("Wrangler multi-Worker Service Binding + local D1 integration passed: signed RS256 JWT via test-only JWKS fixture, actual gateway-to-private-Worker Service Binding, authorized resource read, tenant-scoped criteria list/version reads, tenant-admin draft create, reviewer assignment/revocation, site-scoped human observation verification, independent ingestion-actor checks, auditable verification revocation and persisted registry resolution and sample comparison, cross-tenant denial, missing grant, invalid JWT rejection, caller trust-header/cookie isolation");
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
