import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHmac, createPrivateKey, randomUUID, sign } from "node:crypto";
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
  console.log("Wrangler multi-Worker Service Binding + local D1 integration passed: signed RS256 JWT via test-only JWKS fixture, actual gateway-to-private-Worker Service Binding, authorized resource read, tenant-scoped criteria list/version reads, tenant-admin draft create, reviewer assignment/revocation, and dual-role approval lifecycle, cross-tenant denial, missing grant, invalid JWT rejection, caller trust-header/cookie isolation");
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
