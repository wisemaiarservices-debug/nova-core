import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, createHmac, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

const base = "http://127.0.0.1:8787";
const secret = "local-ci-only-secret-not-for-any-deployment";
const issuer = "https://nova-ci.cloudflareaccess.com";
const audience = "nova-ci-test-audience";
const supabaseIssuer = "https://supabase-ci.example.test/auth/v1";
const supabaseAudience = "authenticated";
const supabaseKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const supabaseJwk = { ...supabaseKeys.publicKey.export({ format: "jwk" }),
  kid: "supabase-local-ephemeral", alg: "RS256", use: "sig", key_ops: ["verify"] };
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
function supabaseToken(subject = "supabase-ci-user", overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: supabaseJwk.kid }));
  const claims = b64url(JSON.stringify({ iss: supabaseIssuer, aud: supabaseAudience,
    sub: subject, role: "authenticated", iat: now - 2, exp: now + 300, ...overrides }));
  const input = head + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), supabaseKeys.privateKey).toString("base64url");
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

  // Configure the local-only API verifier with an ephemeral public key. The
  // matching private key remains in this runner process and is never persisted.
  const jwksReady = await throughGateway("/__ci/supabase-jwks", accessToken(),
    { "content-type": "application/json" }, "POST", JSON.stringify({ keys: [supabaseJwk] }));
  assert.equal(jwksReady.response.status, 200, JSON.stringify(jwksReady.body));

  // Concurrent consumption of one challenge must produce one request and one event.
  const concurrentChallengePair = {
    cloudflareSubject: "ci-concurrent-cloudflare-reviewer",
    supabaseSubject: "supabase-ci-concurrent-user",
  };
  const concurrentBearer = { authorization: "Bearer " + supabaseToken(concurrentChallengePair.supabaseSubject),
    "content-type": "application/json" };
  const concurrentChallenge = await throughGateway("/api/v1/identity-links/challenges",
    accessToken(concurrentChallengePair.cloudflareSubject), concurrentBearer, "POST", "{}");
  assert.equal(concurrentChallenge.response.status, 201, JSON.stringify(concurrentChallenge.body));
  const concurrentConsume = await Promise.all([1, 2].map(() => throughGateway(
    "/api/v1/identity-links/challenges/" + concurrentChallenge.body.data.challenge_id + "/consume",
    accessToken(concurrentChallengePair.cloudflareSubject), concurrentBearer, "POST",
    JSON.stringify({ challenge: concurrentChallenge.body.data.challenge }))));
  assert.deepEqual(concurrentConsume.map(item => item.response.status).sort(), [201, 409],
    JSON.stringify(concurrentConsume.map(item => ({ status: item.response.status, body: item.body }))));
  const concurrentWinner = concurrentConsume.find(item => item.response.status === 201);
  assert.ok(concurrentWinner?.body.data.link_request_id);
  const concurrentState = await throughGateway(
    "/__ci/identity-link-state?challenge_id=" + encodeURIComponent(concurrentChallenge.body.data.challenge_id) +
      "&request_id=" + encodeURIComponent(concurrentWinner.body.data.link_request_id));
  assert.equal(concurrentState.response.status, 200, JSON.stringify(concurrentState.body));
  assert.equal(concurrentState.body.challenge.status, "consumed");
  assert.equal(concurrentState.body.request.status, "pending");

  const linkedCloudflareSubject = "ci-measurement-reviewer";
  const bearer = { authorization: "Bearer " + supabaseToken(),
    "content-type": "application/json" };
  const challengeCreated = await throughGateway("/api/v1/identity-links/challenges",
    accessToken(linkedCloudflareSubject), bearer, "POST", "{}");
  assert.equal(challengeCreated.response.status, 201, JSON.stringify(challengeCreated.body));
  assert.match(challengeCreated.body.data.challenge, /^[A-Za-z0-9_-]{43}$/);

  const mismatchedIdentity = await throughGateway(
    "/api/v1/identity-links/challenges/" + challengeCreated.body.data.challenge_id + "/consume",
    accessToken(linkedCloudflareSubject), {
      authorization: "Bearer " + supabaseToken("different-supabase-user"),
      "content-type": "application/json",
    }, "POST", JSON.stringify({ challenge: challengeCreated.body.data.challenge }));
  assert.equal(mismatchedIdentity.response.status, 409, JSON.stringify(mismatchedIdentity.body));

  const challengeConsumed = await throughGateway(
    "/api/v1/identity-links/challenges/" + challengeCreated.body.data.challenge_id + "/consume",
    accessToken(linkedCloudflareSubject), bearer, "POST",
    JSON.stringify({ challenge: challengeCreated.body.data.challenge }));
  assert.equal(challengeConsumed.response.status, 201, JSON.stringify(challengeConsumed.body));
  const replayedChallenge = await throughGateway(
    "/api/v1/identity-links/challenges/" + challengeCreated.body.data.challenge_id + "/consume",
    accessToken(linkedCloudflareSubject), bearer, "POST",
    JSON.stringify({ challenge: challengeCreated.body.data.challenge }));
  assert.equal(replayedChallenge.response.status, 409, JSON.stringify(replayedChallenge.body));

  const linkRequestId = challengeConsumed.body.data.link_request_id;
  const persistedIdentityState = await throughGateway(
    "/__ci/identity-link-state?challenge_id=" + encodeURIComponent(challengeCreated.body.data.challenge_id) +
      "&request_id=" + encodeURIComponent(linkRequestId));
  assert.equal(persistedIdentityState.response.status, 200, JSON.stringify(persistedIdentityState.body));
  assert.equal(persistedIdentityState.body.challenge.challenge_sha256,
    createHash("sha256").update(challengeCreated.body.data.challenge).digest("hex"));
  assert.equal(persistedIdentityState.body.challenge.status, "consumed");
  assert.equal(persistedIdentityState.body.request.status, "pending");
  assert.equal(persistedIdentityState.body.challenge_columns.some(name =>
    /^(?:token|challenge|access_token|jwt)$/i.test(name)), false);
  assert.equal(persistedIdentityState.body.request_columns.some(name =>
    /token|bearer|jwt/i.test(name)), false);

  const pendingLinks = await throughGateway(
    "/api/v1/tenants/tenant-http-a/identity-links/pending", accessToken("ci-human-subject"));
  assert.equal(pendingLinks.response.status, 200, JSON.stringify(pendingLinks.body));
  assert.equal(pendingLinks.body.data.some(item => item.id === linkRequestId &&
    item.supabase_subject === "supabase-ci-user" &&
    item.cloudflare_subject === linkedCloudflareSubject), true);

  const decisionPath = "/api/v1/tenants/tenant-http-a/identity-links/" + linkRequestId + "/decision";
  const approvalBody = { decision: "approve", reason: "CI dual identity approval",
    idempotency_key: "ci-dual-identity-approve-1" };
  const identityLinkAuditFailure = await throughGateway(decisionPath, accessToken("ci-human-subject"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "approve", reason: "CI injected identity-link audit failure",
      idempotency_key: "ci-dual-identity-audit-failure" }));
  assert.equal(identityLinkAuditFailure.response.status, 503, JSON.stringify(identityLinkAuditFailure.body));
  const pendingAfterAuditFailure = await throughGateway(
    "/api/v1/tenants/tenant-http-a/identity-links/pending", accessToken("ci-human-subject"));
  assert.equal(pendingAfterAuditFailure.response.status, 200, JSON.stringify(pendingAfterAuditFailure.body));
  assert.equal(pendingAfterAuditFailure.body.data.some(item => item.id === linkRequestId), true);

  const approved = await throughGateway(decisionPath, accessToken("ci-human-subject"),
    { "content-type": "application/json" }, "POST", JSON.stringify(approvalBody));
  assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.status, "approved");

  const approvalRetry = await throughGateway(decisionPath, accessToken("ci-human-subject"),
    { "content-type": "application/json" }, "POST", JSON.stringify(approvalBody));
  assert.equal(approvalRetry.response.status, 200, JSON.stringify(approvalRetry.body));
  assert.equal(approvalRetry.body.data.status, "approved");

  const crossTenantAfterApproval = await throughGateway("/api/v1/tenants/tenant-http-b/sites",
    accessToken(linkedCloudflareSubject), bearer);
  assert.equal(crossTenantAfterApproval.response.status, 404);

  const linkedSiteList = await throughGateway("/api/v1/tenants/tenant-http-a/sites",
    accessToken(linkedCloudflareSubject), bearer);
  assert.equal(linkedSiteList.response.status, 200, JSON.stringify(linkedSiteList.body));
  assert.equal(linkedSiteList.body.data.some(site => site.id === "site-http-a"), true);

  const linkedObservations = await throughGateway(
    "/api/v1/tenants/tenant-http-a/sites/site-http-a/observations",
    accessToken(linkedCloudflareSubject), bearer);
  assert.equal(linkedObservations.response.status, 200, JSON.stringify(linkedObservations.body));
  assert.equal(linkedObservations.body.data.some(item => item.id === "obs-http-verified"), true);

  const revoked = await throughGateway(decisionPath, accessToken("ci-human-subject"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "revoke", reason: "CI dual identity revocation",
      idempotency_key: "ci-dual-identity-revoke-1" }));
  assert.equal(revoked.response.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.data.status, "revoked");

  const deniedAfterRevoke = await throughGateway("/api/v1/tenants/tenant-http-a/sites",
    accessToken(linkedCloudflareSubject), bearer);
  assert.equal(deniedAfterRevoke.response.status, 404, JSON.stringify(deniedAfterRevoke.body));


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

  // Exercise membership lifecycle and possession-based invitation using real
  // D1 rows through the public Access gateway and private Worker binding.
  const membershipActionsPath = "/api/v1/tenants/tenant-http-a/membership-actions";
  async function membershipAction(subject, payload) {
    return throughGateway(membershipActionsPath, accessToken(subject),
      { "content-type": "application/json" }, "POST", JSON.stringify(payload));
  }
  const roleChanged = await membershipAction("ci-human-subject", {
    membership_id: "membership-http-lifecycle", action: "change_role",
    role: "analyst", reason: "CI role transition fixture",
  });
  assert.equal(roleChanged.response.status, 200, JSON.stringify(roleChanged.body));
  assert.equal(roleChanged.body.data.role, "analyst");
  assert.equal(roleChanged.body.data.event_type, "role_changed");

  const adminRoleChange = await membershipAction("ci-http-admin", {
    membership_id: "membership-http-lifecycle", action: "change_role",
    role: "viewer", reason: "Admin role change must be denied",
  });
  assert.equal(adminRoleChange.response.status, 404);

  const suspended = await membershipAction("ci-http-admin", {
    membership_id: "membership-http-lifecycle", action: "suspend",
    reason: "CI temporary suspension",
  });
  assert.equal(suspended.response.status, 200, JSON.stringify(suspended.body));
  assert.equal(suspended.body.data.status, "inactive");
  const suspendedMemberRead = await throughGateway(
    "/api/v1/tenants/tenant-http-a/sites/site-http-a", accessToken("ci-lifecycle-member"));
  assert.equal(suspendedMemberRead.response.status, 404,
    "suspended membership must lose access despite its still-active site grant");


  const reactivated = await membershipAction("ci-human-subject", {
    membership_id: "membership-http-lifecycle", action: "reactivate",
    reason: "CI access restoration",
  });
  assert.equal(reactivated.response.status, 200, JSON.stringify(reactivated.body));
  assert.equal(reactivated.body.data.status, "active");
  const reactivatedMemberRead = await throughGateway(
    "/api/v1/tenants/tenant-http-a/sites/site-http-a", accessToken("ci-lifecycle-member"));
  assert.equal(reactivatedMemberRead.response.status, 200,
    "reactivation restores access only while the exact site grant remains active");


  const membershipRevoked = await membershipAction("ci-human-subject", {
    membership_id: "membership-http-lifecycle", action: "revoke",
    reason: "CI final membership revocation",
  });
  assert.equal(membershipRevoked.response.status, 200, JSON.stringify(membershipRevoked.body));
  assert.equal(membershipRevoked.body.data.status, "revoked");
  const revokedMemberRead = await throughGateway(
    "/api/v1/tenants/tenant-http-a/sites/site-http-a", accessToken("ci-lifecycle-member"));
  assert.equal(revokedMemberRead.response.status, 404,
    "revoked membership must lose access even though its site grant row remains");


  const revokedAgain = await membershipAction("ci-human-subject", {
    membership_id: "membership-http-lifecycle", action: "reactivate",
    reason: "Illegal transition after revocation",
  });
  assert.equal(revokedAgain.response.status, 409);

  const invitationCreated = await throughGateway(
    "/api/v1/tenants/tenant-http-a/membership-invitations", accessToken("ci-human-subject"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ role: "operator", reason: "CI invitation acceptance fixture" }));
  assert.equal(invitationCreated.response.status, 201, JSON.stringify(invitationCreated.body));
  assert.match(invitationCreated.body.data.invitation_token, /^[A-Za-z0-9_-]{43}$/);
  const invitationAccepted = await throughGateway(
    "/api/v1/tenants/tenant-http-a/membership-invitations/" +
      invitationCreated.body.data.invitation_id + "/accept", accessToken("ci-invited-human"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ invitation_token: invitationCreated.body.data.invitation_token }));
  assert.equal(invitationAccepted.response.status, 201, JSON.stringify(invitationAccepted.body));
  assert.equal(invitationAccepted.body.data.subject, "ci-invited-human");
  assert.equal(invitationAccepted.body.data.role, "operator");

  const siteGrantPath = "/api/v1/tenants/tenant-http-a/site-grants";
  async function siteGrant(subject, payload) {
    return throughGateway(siteGrantPath, accessToken(subject),
      { "content-type": "application/json" }, "POST", JSON.stringify(payload));
  }
  const siteGrantCreated = await siteGrant("ci-human-subject", {
    action: "grant", subject: "ci-invited-human", site_id: "site-http-a",
    grant_action: "read", reason: "CI site access grant",
  });
  assert.equal(siteGrantCreated.response.status, 201, JSON.stringify(siteGrantCreated.body));
  assert.equal(siteGrantCreated.body.data.status, "active");
  assert.equal(siteGrantCreated.body.data.resource_type, "site");
  const adminPrivilegedGrant = await siteGrant("ci-http-admin", {
    action: "grant", subject: "ci-invited-human", site_id: "site-http-a",
    grant_action: "delete", reason: "Admin must not grant destructive access",
  });
  assert.equal(adminPrivilegedGrant.response.status, 404);

  const siteGrantRevoked = await siteGrant("ci-human-subject", {
    action: "revoke", subject: "ci-invited-human", site_id: "site-http-a",
    grant_action: "read", reason: "CI site access revocation",
  });
  assert.equal(siteGrantRevoked.response.status, 200, JSON.stringify(siteGrantRevoked.body));
  assert.equal(siteGrantRevoked.body.data.status, "revoked");

  // Resource grants are exact (no site inheritance) and independently audited.
  const resourceGrantPath = "/api/v1/tenants/tenant-http-a/resource-grants";
  async function resourceGrant(subject, payload) {
    return throughGateway(resourceGrantPath, accessToken(subject),
      { "content-type": "application/json" }, "POST", JSON.stringify(payload));
  }
  const crossTenantTarget = await resourceGrant("ci-human-subject", {
    action: "grant", subject: "ci-other-tenant-member", resource_type: "asset",
    resource_id: "asset-http-grant", grant_action: "read",
    reason: "Cross-tenant target must be denied",
  });
  assert.equal(crossTenantTarget.response.status, 404);
  const crossTenantResource = await resourceGrant("ci-human-subject", {
    action: "grant", subject: "ci-invited-human", resource_type: "asset",
    resource_id: "asset-http-b", grant_action: "read",
    reason: "Cross-tenant resource must be denied",
  });
  assert.equal(crossTenantResource.response.status, 404);

  const auditFailure = await resourceGrant("ci-human-subject", {
    action: "grant", subject: "ci-invited-human", resource_type: "asset",
    resource_id: "asset-http-grant", grant_action: "read",
    reason: "CI injected resource grant audit failure",
  });
  assert.equal(auditFailure.response.status, 503, JSON.stringify(auditFailure.body));
  const auditFailureDidNotGrant = await throughGateway(
    "/api/v1/tenants/tenant-http-a/assets/asset-http-grant", accessToken("ci-invited-human"));
  assert.equal(auditFailureDidNotGrant.response.status, 404);

  const concurrentGrants = await Promise.all([1, 2].map(() =>
    resourceGrant("ci-human-subject", {
      action: "grant", subject: "ci-invited-human", resource_type: "asset",
      resource_id: "asset-http-grant", grant_action: "read",
      reason: "CI simultaneous exact grant",
    })));
  assert.deepEqual(concurrentGrants.map(result => result.response.status).sort(),
    [201, 409]);
  const concurrentGrantRead = await throughGateway(
    "/api/v1/tenants/tenant-http-a/assets/asset-http-grant", accessToken("ci-invited-human"));
  assert.equal(concurrentGrantRead.response.status, 200, JSON.stringify(concurrentGrantRead.body));
  const concurrentGrantRevoke = await resourceGrant("ci-human-subject", {
    action: "revoke", subject: "ci-invited-human", resource_type: "asset",
    resource_id: "asset-http-grant", grant_action: "read",
    reason: "CI cleanup after simultaneous grant",
  });
  assert.equal(concurrentGrantRevoke.response.status, 200, JSON.stringify(concurrentGrantRevoke.body));
  const concurrentGrantDenied = await throughGateway(
    "/api/v1/tenants/tenant-http-a/assets/asset-http-grant", accessToken("ci-invited-human"));
  assert.equal(concurrentGrantDenied.response.status, 404);

  const resourceCases = [
    ["asset", "asset-http-grant"],
    ["source", "source-http-grant"],
    ["observation", "obs-http-grant"],
  ];
  for (const [resource_type, resource_id] of resourceCases) {
    const deniedBeforeGrant = await throughGateway(
      "/api/v1/tenants/tenant-http-a/" + (resource_type === "observation" ? "observations" : resource_type === "source" ? "sources" : "assets") + "/" + resource_id,
      accessToken("ci-invited-human"));
    assert.equal(deniedBeforeGrant.response.status, 404);
    const granted = await resourceGrant("ci-human-subject", {
      action: "grant", subject: "ci-invited-human", resource_type, resource_id,
      grant_action: "read", reason: "CI exact resource access grant",
    });
    assert.equal(granted.response.status, 201, JSON.stringify(granted.body));
    assert.equal(granted.body.data.resource_type, resource_type);
    const allowedResource = await throughGateway(
      "/api/v1/tenants/tenant-http-a/" + (resource_type === "observation" ? "observations" : resource_type === "source" ? "sources" : "assets") + "/" + resource_id,
      accessToken("ci-invited-human"));
    assert.equal(allowedResource.response.status, 200, JSON.stringify(allowedResource.body));
    const revoked = await resourceGrant("ci-human-subject", {
      action: "revoke", subject: "ci-invited-human", resource_type, resource_id,
      grant_action: "read", reason: "CI exact resource access revocation",
    });
    assert.equal(revoked.response.status, 200, JSON.stringify(revoked.body));
    const deniedAfterRevoke = await throughGateway(
      "/api/v1/tenants/tenant-http-a/" + (resource_type === "observation" ? "observations" : resource_type === "source" ? "sources" : "assets") + "/" + resource_id,
      accessToken("ci-invited-human"));
    assert.equal(deniedAfterRevoke.response.status, 404);
  }
  const adminResourceDelete = await resourceGrant("ci-http-admin", {
    action: "grant", subject: "ci-invited-human", resource_type: "asset",
    resource_id: "asset-http-grant", grant_action: "delete",
    reason: "CI admin cannot grant destructive access",
  });
  assert.equal(adminResourceDelete.response.status, 404);

  const membershipAudit = await throughGateway(
    "/api/v1/tenants/tenant-http-a/membership-events", accessToken("ci-human-subject"));
  assert.equal(membershipAudit.response.status, 200, JSON.stringify(membershipAudit.body));
  assert.equal(membershipAudit.body.data.some(event =>
    event.event_type === "membership_role_changed" &&
    event.membership_id === "membership-http-lifecycle"), true);
  assert.equal(membershipAudit.body.data.some(event =>
    event.event_type === "membership_suspended" &&
    event.membership_id === "membership-http-lifecycle"), true);
  assert.equal(membershipAudit.body.data.some(event =>
    event.event_type === "membership_reactivated" &&
    event.membership_id === "membership-http-lifecycle"), true);
  assert.equal(membershipAudit.body.data.some(event =>
    event.event_type === "membership_revoked" &&
    event.membership_id === "membership-http-lifecycle"), true);
  assert.equal(membershipAudit.body.data.some(event =>
    event.event_type === "invitation_accepted" &&
    event.subject === "ci-invited-human"), true);
  assert.equal(membershipAudit.body.data.some(event =>
    event.event_type === "site_grant_granted" && event.subject === "ci-invited-human"), true);
  assert.equal(membershipAudit.body.data.some(event =>
    event.event_type === "site_grant_revoked" && event.subject === "ci-invited-human"), true);
  assert.equal(membershipAudit.body.data.some(event =>
    event.event_type === "resource_grant_granted" && event.subject === "ci-invited-human"), true);
  assert.equal(membershipAudit.body.data.some(event =>
    event.event_type === "resource_grant_revoked" && event.subject === "ci-invited-human"), true);

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

  const policyInitiallyVerified = await throughGateway(
    "/api/v1/tenants/tenant-http-a/sites/site-http-a/assets/asset-http-grant/measurement-quality-policies/policy-http-revocation/verification",
    accessToken("ci-measurement-reviewer"), { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "verify", evidence_ref: "fixture:policy-http-revocation-verification" }));
  assert.equal(policyInitiallyVerified.response.status, 201,
    JSON.stringify(policyInitiallyVerified.body));
  assert.equal(policyInitiallyVerified.body.data.status, "verified");

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

  const reviewerRevoked = await throughGateway(
    "/api/v1/tenants/tenant-http-a/water-quality-criteria/reviewers/revoke",
    accessToken(), { "content-type": "application/json" }, "POST",
    JSON.stringify({ ...reviewer, evidence_ref: "fixture:reviewer-revocation", reason: "CI revocation fixture" }));
  assert.equal(reviewerRevoked.response.status, 200, JSON.stringify(reviewerRevoked.body));
  assert.equal(reviewerRevoked.body.data.status, "revoked");
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

  const adminCannotTransferOwnership = await throughGateway(
    "/api/v1/tenants/tenant-http-a/ownership-transfer", accessToken("ci-http-admin"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ target_membership_id: "membership-http-reviewer",
      reason: "Admin must not transfer ownership" }));
  assert.equal(adminCannotTransferOwnership.response.status, 404);

  const ownershipTransfer = await throughGateway(
    "/api/v1/tenants/tenant-http-a/ownership-transfer", accessToken("ci-human-subject"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ target_membership_id: "membership-http-reviewer",
      reason: "CI designated tenant successor" }));
  assert.equal(ownershipTransfer.response.status, 200, JSON.stringify(ownershipTransfer.body));
  assert.equal(ownershipTransfer.body.data.new_owner_subject, "ci-measurement-reviewer");
  assert.equal(ownershipTransfer.body.data.previous_owner_role, "tenant_admin");

  const previousOwnerCannotTransferAgain = await throughGateway(
    "/api/v1/tenants/tenant-http-a/ownership-transfer", accessToken("ci-human-subject"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ target_membership_id: "membership-http-reviewer",
      reason: "Previous owner is now admin" }));
  assert.equal(previousOwnerCannotTransferAgain.response.status, 404);

  const newOwnerAudit = await throughGateway(
    "/api/v1/tenants/tenant-http-a/membership-events", accessToken("ci-measurement-reviewer"));
  assert.equal(newOwnerAudit.response.status, 200, JSON.stringify(newOwnerAudit.body));
  assert.equal(newOwnerAudit.body.data.some(event =>
    event.event_type === "membership_role_changed" &&
    event.membership_id === "membership-http-reviewer" &&
    event.previous_role === "viewer" && event.new_role === "tenant_owner"), true);
  assert.equal(newOwnerAudit.body.data.some(event =>
    event.event_type === "membership_role_changed" &&
    event.membership_id === "membership-http-a" &&
    event.previous_role === "tenant_owner" && event.new_role === "tenant_admin"), true);

  const nonOwnerCannotSuspendTenant = await throughGateway(
    "/api/v1/tenants/tenant-http-b/lifecycle-actions", accessToken("ci-other-tenant-member"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ action: "suspend", reason: "Must be owner" }));
  assert.equal(nonOwnerCannotSuspendTenant.response.status, 404);

  const tenantSuspended = await throughGateway(
    "/api/v1/tenants/tenant-http-b/lifecycle-actions", accessToken("ci-tenant-b-owner"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ action: "suspend", reason: "CI lifecycle suspension" }));
  assert.equal(tenantSuspended.response.status, 200, JSON.stringify(tenantSuspended.body));
  assert.equal(tenantSuspended.body.data.status, "suspended");

  const suspendedSiteRead = await throughGateway(
    "/api/v1/tenants/tenant-http-b/sites/site-http-b", accessToken("ci-tenant-b-owner"));
  assert.equal(suspendedSiteRead.response.status, 404);

  const suspendedAudit = await throughGateway(
    "/api/v1/tenants/tenant-http-b/lifecycle-events", accessToken("ci-tenant-b-owner"));
  assert.equal(suspendedAudit.response.status, 200, JSON.stringify(suspendedAudit.body));
  assert.equal(suspendedAudit.body.data.some(event => event.event_type === "suspended"), true);

  const tenantReactivated = await throughGateway(
    "/api/v1/tenants/tenant-http-b/lifecycle-actions", accessToken("ci-tenant-b-owner"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ action: "reactivate", reason: "CI lifecycle reactivation" }));
  assert.equal(tenantReactivated.response.status, 200, JSON.stringify(tenantReactivated.body));
  assert.equal(tenantReactivated.body.data.status, "active");
  const activeSiteRead = await throughGateway(
    "/api/v1/tenants/tenant-http-b/sites/site-http-b", accessToken("ci-tenant-b-owner"));
  assert.equal(activeSiteRead.response.status, 200);

  const tenantArchived = await throughGateway(
    "/api/v1/tenants/tenant-http-b/lifecycle-actions", accessToken("ci-tenant-b-owner"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ action: "archive", reason: "CI lifecycle archival" }));
  assert.equal(tenantArchived.response.status, 200, JSON.stringify(tenantArchived.body));
  assert.equal(tenantArchived.body.data.status, "archived");

  const archivedReactivation = await throughGateway(
    "/api/v1/tenants/tenant-http-b/lifecycle-actions", accessToken("ci-tenant-b-owner"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ action: "reactivate", reason: "Archived tenants are terminal" }));
  assert.equal(archivedReactivation.response.status, 409);
  const archivedSiteRead = await throughGateway(
    "/api/v1/tenants/tenant-http-b/sites/site-http-b", accessToken("ci-tenant-b-owner"));
  assert.equal(archivedSiteRead.response.status, 404);

  const archivedAudit = await throughGateway(
    "/api/v1/tenants/tenant-http-b/lifecycle-events", accessToken("ci-tenant-b-owner"));
  assert.equal(archivedAudit.response.status, 200, JSON.stringify(archivedAudit.body));
  assert.deepEqual(archivedAudit.body.data.map(event => event.event_type).sort(),
    ["archived", "reactivated", "suspended"]);


  // Exercise the new assessment-operation endpoints end-to-end through the
  // public Access gateway, private Worker Service Binding and disposable D1.
  // The fixture observation is deliberately unverified, so completion must
  // produce a durable not_assessed result rather than a scientific pass.
  const operationPath = "/api/v1/tenants/tenant-http-a/observations/obs-http-verified/measurement-assessment-operations";
  async function operationRequest(path, subject = "ci-human-subject", method = "POST", payload = {}) {
    return throughGateway(path, accessToken(subject),
      method === "POST" ? { "content-type": "application/json" } : {},
      method, method === "POST" ? JSON.stringify(payload) : undefined);
  }
  const legacyAssessment = await throughGateway(
    "/api/v1/tenants/tenant-http-a/observations/obs-http-verified/measurement-quality-assessment",
    accessToken("ci-human-subject"), { "content-type": "application/json" }, "POST", "{}");
  assert.equal(legacyAssessment.response.status, 410, JSON.stringify(legacyAssessment.body));
  assert.equal(legacyAssessment.body.error, "assessment_operation_required");

  const reservedOperation = await operationRequest(operationPath);
  assert.equal(reservedOperation.response.status, 201, JSON.stringify(reservedOperation.body));
  const operationId = reservedOperation.body.data.operation_id;
  assert.match(operationId, /^[0-9a-f-]{36}$/);
  assert.equal(reservedOperation.body.data.state, "reserved");
  assert.equal("actor_subject" in reservedOperation.body.data, false);
  assert.equal("request_digest" in reservedOperation.body.data, false);

  // Same actor, observation and canonical intent recover the same durable ID,
  // including after terminal completion; no duplicate operation is created.
  const reserveReplay = await operationRequest(operationPath);
  assert.equal(reserveReplay.response.status, 200, JSON.stringify(reserveReplay.body));
  assert.equal(reserveReplay.body.data.operation_id, operationId);

  const operationReadPath = "/api/v1/tenants/tenant-http-a/measurement-assessment-operations/" + operationId;
  const operationRead = await operationRequest(operationReadPath, "ci-human-subject", "GET");
  assert.equal(operationRead.response.status, 200, JSON.stringify(operationRead.body));
  assert.equal(operationRead.body.data.state, "reserved");

  // A different active site member cannot read or mutate another actor's
  // operation, even though that member independently has site read access.
  const crossActorRead = await operationRequest(operationReadPath, "ci-measurement-reviewer", "GET");
  assert.equal(crossActorRead.response.status, 404);
  const crossActorClaim = await operationRequest(operationReadPath + "/claim", "ci-measurement-reviewer");
  assert.equal(crossActorClaim.response.status, 404);

  let claimedOperation = await operationRequest(operationReadPath + "/claim");
  assert.equal(claimedOperation.response.status, 200, JSON.stringify(claimedOperation.body));
  assert.equal(claimedOperation.body.data.state, "running");
  assert.equal(claimedOperation.body.data.lease_version, 1);
  assert.equal(typeof claimedOperation.body.data.lease_request_id, "string");
  // Expire the just-claimed operation in the disposable local D1 database,
  // then recover it. The stale lease must be fenced out before completion.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const recoveredLease = await operationRequest(operationReadPath + "/claim");
  assert.equal(recoveredLease.response.status, 200, JSON.stringify(recoveredLease.body));
  assert.equal(recoveredLease.body.data.lease_version, claimedOperation.body.data.lease_version + 1);
  assert.notEqual(recoveredLease.body.data.lease_request_id, claimedOperation.body.data.lease_request_id);
  const staleWorkerCompletion = await operationRequest(operationReadPath + "/complete", "ci-human-subject", "POST", {
    expected_lease_version: claimedOperation.body.data.lease_version,
    expected_lease_request_id: claimedOperation.body.data.lease_request_id,
  });
  assert.equal(staleWorkerCompletion.response.status, 409, JSON.stringify(staleWorkerCompletion.body));
  claimedOperation = recoveredLease;

  const renewedOperation = await operationRequest(operationReadPath + "/renew", "ci-human-subject", "POST", {
    expected_lease_version: claimedOperation.body.data.lease_version,
    expected_lease_request_id: claimedOperation.body.data.lease_request_id,
    expected_lease_expires_at: claimedOperation.body.data.lease_expires_at,
  });
  assert.equal(renewedOperation.response.status, 200, JSON.stringify(renewedOperation.body));
  assert.equal(renewedOperation.body.data.lease_version, claimedOperation.body.data.lease_version + 1);
  assert.notEqual(renewedOperation.body.data.lease_request_id,
    claimedOperation.body.data.lease_request_id);

  const completedOperation = await operationRequest(operationReadPath + "/complete", "ci-human-subject", "POST", {
    expected_lease_version: renewedOperation.body.data.lease_version,
    expected_lease_request_id: renewedOperation.body.data.lease_request_id,
  });
  assert.equal([200, 201].includes(completedOperation.response.status), true, JSON.stringify(completedOperation.body));
  assert.equal(completedOperation.body.data.status, "not_assessed");
  assert.equal(completedOperation.body.data.reason_code, "observation_not_verified");
  assert.equal(completedOperation.body.data.request_id, operationId);

  // Lost-response retry returns the immutable original assessment and the
  // operation is now terminal; the reserve replay above remains recoverable.
  const completionReplay = await operationRequest(operationReadPath + "/complete", "ci-human-subject", "POST", {
    expected_lease_version: renewedOperation.body.data.lease_version,
    expected_lease_request_id: renewedOperation.body.data.lease_request_id,
  });
  assert.equal(completionReplay.response.status, 200, JSON.stringify(completionReplay.body));
  assert.equal(completionReplay.body.data.id, completedOperation.body.data.id);
  const terminalOperation = await operationRequest(operationReadPath, "ci-human-subject", "GET");
  assert.equal(terminalOperation.response.status, 200);
  assert.equal(terminalOperation.body.data.state, "not_assessed");
  assert.equal(terminalOperation.body.data.assessment.status, "not_assessed");
  assert.equal(terminalOperation.body.data.assessment.request_id, operationId);
  assert.equal(terminalOperation.body.data.events.some(event => event.event_type === "completed" ||
    event.event_type === "not_assessed"), true);

  // Re-assessment is explicit: the completed operation must be named as the
  // predecessor, and the successor receives a distinct durable operation ID.
  const successor = await operationRequest(operationPath, "ci-human-subject", "POST", {
    predecessor_operation_id: operationId,
  });
  assert.equal(successor.response.status, 201, JSON.stringify(successor.body));
  assert.notEqual(successor.body.data.operation_id, operationId);
  assert.equal(successor.body.data.predecessor_operation_id, operationId);
  // Exercise actual simultaneous route requests against the same disposable
  // D1 operation. Exactly one claim and one lease renewal may win.
  const successorId = successor.body.data.operation_id;
  const successorRoute = "/api/v1/tenants/tenant-http-a/measurement-assessment-operations/" + successorId;
  const claimRace = await Promise.all([
    operationRequest(successorRoute + "/claim"),
    operationRequest(successorRoute + "/claim"),
  ]);
  assert.deepEqual(claimRace.map(item => item.response.status).sort((a, b) => a - b), [200, 409]);
  const claimWinner = claimRace.find(item => item.response.status === 200);
  assert.ok(claimWinner);
  assert.equal(claimWinner.body.data.state, "running");
  assert.equal(claimWinner.body.data.lease_version, 1);

  const renewPayload = {
    expected_lease_version: claimWinner.body.data.lease_version,
    expected_lease_request_id: claimWinner.body.data.lease_request_id,
    expected_lease_expires_at: claimWinner.body.data.lease_expires_at,
  };
  const renewRace = await Promise.all([
    operationRequest(successorRoute + "/renew", "ci-human-subject", "POST", renewPayload),
    operationRequest(successorRoute + "/renew", "ci-human-subject", "POST", renewPayload),
  ]);
  assert.deepEqual(renewRace.map(item => item.response.status).sort((a, b) => a - b), [200, 409]);
  const renewWinner = renewRace.find(item => item.response.status === 200);
  assert.ok(renewWinner);
  assert.equal(renewWinner.body.data.lease_version, 2);

  // Concurrent completion is idempotent: both callers receive the same
  // immutable assessment, while the D1 trigger appends one terminal event.
  const completePayload = {
    expected_lease_version: renewWinner.body.data.lease_version,
    expected_lease_request_id: renewWinner.body.data.lease_request_id,
  };
  const completionRace = await Promise.all([
    operationRequest(successorRoute + "/complete", "ci-human-subject", "POST", completePayload),
    operationRequest(successorRoute + "/complete", "ci-human-subject", "POST", completePayload),
  ]);
  assert.equal(completionRace.every(item => [200, 201].includes(item.response.status)), true,
    JSON.stringify(completionRace.map(item => item.body)));
  assert.equal(completionRace[0].body.data.id, completionRace[1].body.data.id);
  assert.equal(completionRace[0].body.data.status, "not_assessed");


  // A previously authorized member's durable operation must become
  // inaccessible immediately after the exact site read grant is revoked.
  const operationGrant = await siteGrant("ci-human-subject", {
    action: "grant", subject: "ci-invited-human", site_id: "site-http-a",
    grant_action: "read", reason: "CI assessment operation grant revocation",
  });
  assert.equal(operationGrant.response.status, 201, JSON.stringify(operationGrant.body));
  const revokedGrantOperation = await operationRequest(operationPath, "ci-invited-human");
  assert.equal(revokedGrantOperation.response.status, 201, JSON.stringify(revokedGrantOperation.body));
  const revokedGrantOperationId = revokedGrantOperation.body.data.operation_id;
  const revokedGrantPath = "/api/v1/tenants/tenant-http-a/measurement-assessment-operations/" + revokedGrantOperationId;
  // Reuse this invited actor's already-reserved operation while the exact
  // site grant is active, then suspend membership after claim and before write.
  // The same operation is subsequently checked for site-grant revocation.
  const invitedMembershipId = invitationAccepted.body.data.membership_id;
  assert.match(invitedMembershipId, /^[0-9a-f-]{36}$/i);
  const membershipOperationRoute = revokedGrantPath;
  const membershipClaim = await operationRequest(membershipOperationRoute + "/claim", "ci-invited-human");
  assert.equal(membershipClaim.response.status, 200, JSON.stringify(membershipClaim.body));
  const membershipSuspended = await membershipAction("ci-human-subject", {
    membership_id: invitedMembershipId, action: "suspend",
    reason: "CI suspend member after assessment operation claim",
  });
  assert.equal(membershipSuspended.response.status, 200, JSON.stringify(membershipSuspended.body));
  assert.equal(membershipSuspended.body.data.status, "inactive");
  const membershipDeniedCompletion = await operationRequest(membershipOperationRoute + "/complete", "ci-invited-human", "POST", {
    expected_lease_version: membershipClaim.body.data.lease_version,
    expected_lease_request_id: membershipClaim.body.data.lease_request_id,
  });
  assert.equal(membershipDeniedCompletion.response.status, 404, JSON.stringify(membershipDeniedCompletion.body));
  const membershipReactivated = await membershipAction("ci-human-subject", {
    membership_id: invitedMembershipId, action: "reactivate",
    reason: "CI restore member after assessment authorization test",
  });
  assert.equal(membershipReactivated.response.status, 200, JSON.stringify(membershipReactivated.body));
  assert.equal(membershipReactivated.body.data.status, "active");

  // Tenant suspension after an operation is leased must deny the final write.
  const tenantSuspendedDuringOperation = await throughGateway(
    "/api/v1/tenants/tenant-http-a/lifecycle-actions", accessToken("ci-measurement-reviewer"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ action: "suspend", reason: "CI suspend tenant after assessment operation claim" }));
  assert.equal(tenantSuspendedDuringOperation.response.status, 200, JSON.stringify(tenantSuspendedDuringOperation.body));
  assert.equal(tenantSuspendedDuringOperation.body.data.status, "suspended");
  const tenantDeniedCompletion = await operationRequest(membershipOperationRoute + "/complete", "ci-invited-human", "POST", {
    expected_lease_version: membershipClaim.body.data.lease_version,
    expected_lease_request_id: membershipClaim.body.data.lease_request_id,
  });
  assert.equal(tenantDeniedCompletion.response.status, 404, JSON.stringify(tenantDeniedCompletion.body));
  const tenantReactivatedDuringOperation = await throughGateway(
    "/api/v1/tenants/tenant-http-a/lifecycle-actions", accessToken("ci-measurement-reviewer"),
    { "content-type": "application/json" }, "POST",
    JSON.stringify({ action: "reactivate", reason: "CI restore tenant after assessment authorization test" }));
  assert.equal(tenantReactivatedDuringOperation.response.status, 200, JSON.stringify(tenantReactivatedDuringOperation.body));
  assert.equal(tenantReactivatedDuringOperation.body.data.status, "active");


  // Revoke a verified quality policy while an assessment lease is active.
  // The calibration and mapping remain verified, isolating the policy gate.
  const governedObservationPath = "/api/v1/tenants/tenant-http-a/observations/obs-http-governance-revocation/measurement-assessment-operations";
  const policyOperation = await operationRequest(governedObservationPath);
  assert.equal(policyOperation.response.status, 201, JSON.stringify(policyOperation.body));
  const policyOperationPath = "/api/v1/tenants/tenant-http-a/measurement-assessment-operations/" +
    policyOperation.body.data.operation_id;
  const policyClaim = await operationRequest(policyOperationPath + "/claim");
  assert.equal(policyClaim.response.status, 200, JSON.stringify(policyClaim.body));
  const policyRevokedDuringOperation = await throughGateway(
    "/api/v1/tenants/tenant-http-a/sites/site-http-a/assets/asset-http-grant/measurement-quality-policies/policy-http-revocation/verification",
    accessToken("ci-measurement-reviewer"), { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "revoke", evidence_ref: "fixture:policy-revoked-during-assessment",
      reason: "CI policy revoked after assessment operation claim" }));
  assert.equal(policyRevokedDuringOperation.response.status, 201,
    JSON.stringify(policyRevokedDuringOperation.body));
  assert.equal(policyRevokedDuringOperation.body.data.status, "revoked");
  const policyDeniedAssessment = await operationRequest(policyOperationPath + "/complete",
    "ci-human-subject", "POST", {
      expected_lease_version: policyClaim.body.data.lease_version,
      expected_lease_request_id: policyClaim.body.data.lease_request_id,
    });
  assert.equal([200, 201].includes(policyDeniedAssessment.response.status), true,
    JSON.stringify(policyDeniedAssessment.body));
  assert.equal(policyDeniedAssessment.body.data.status, "not_assessed");
  assert.equal(policyDeniedAssessment.body.data.reason_code, "approved_quality_policy_missing");

  // Continue the same observation's explicit successor chain. With the policy
  // already revoked, calibration remains the next independent evidence gate.
  const calibrationOperation = await operationRequest(governedObservationPath, "ci-human-subject", "POST", {
    predecessor_operation_id: policyOperation.body.data.operation_id,
  });
  assert.equal(calibrationOperation.response.status, 201, JSON.stringify(calibrationOperation.body));
  const calibrationOperationPath = "/api/v1/tenants/tenant-http-a/measurement-assessment-operations/" +
    calibrationOperation.body.data.operation_id;
  const calibrationClaim = await operationRequest(calibrationOperationPath + "/claim");
  assert.equal(calibrationClaim.response.status, 200, JSON.stringify(calibrationClaim.body));
  const calibrationRevokedDuringOperation = await throughGateway(
    "/api/v1/tenants/tenant-http-a/sites/site-http-a/assets/asset-http-grant/calibrations/cal-http-revocation/verification",
    accessToken("ci-measurement-reviewer"), { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "revoke", evidence_ref: "fixture:calibration-revoked-during-assessment",
      reason: "CI calibration revoked after assessment operation claim" }));
  assert.equal(calibrationRevokedDuringOperation.response.status, 201,
    JSON.stringify(calibrationRevokedDuringOperation.body));
  assert.equal(calibrationRevokedDuringOperation.body.data.verification_status, "revoked");
  const calibrationDeniedAssessment = await operationRequest(calibrationOperationPath + "/complete",
    "ci-human-subject", "POST", {
      expected_lease_version: calibrationClaim.body.data.lease_version,
      expected_lease_request_id: calibrationClaim.body.data.lease_request_id,
    });
  assert.equal([200, 201].includes(calibrationDeniedAssessment.response.status), true,
    JSON.stringify(calibrationDeniedAssessment.body));
  assert.equal(calibrationDeniedAssessment.body.data.status, "not_assessed");
  assert.equal(calibrationDeniedAssessment.body.data.reason_code, "verified_calibration_missing_or_expired");

  // Mapping revocation is an independent evidence gate. The policy and
  // calibration have already been revoked in this fixture, but mapping is
  // evaluated first; this proves the latest mapping event is checked at the
  // final completion write rather than trusting the earlier lease.
  const mappingOperation = await operationRequest(governedObservationPath, "ci-human-subject", "POST", {
    predecessor_operation_id: calibrationOperation.body.data.operation_id,
  });
  assert.equal(mappingOperation.response.status, 201, JSON.stringify(mappingOperation.body));
  const mappingOperationPath = "/api/v1/tenants/tenant-http-a/measurement-assessment-operations/" +
    mappingOperation.body.data.operation_id;
  const mappingClaim = await operationRequest(mappingOperationPath + "/claim");
  assert.equal(mappingClaim.response.status, 200, JSON.stringify(mappingClaim.body));
  const mappingRevokedDuringOperation = await throughGateway(
    "/api/v1/tenants/tenant-http-a/sites/site-http-a/assets/asset-http-grant/sensor-source-mappings/mapping-http-revocation/verification",
    accessToken("ci-measurement-reviewer"), { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "revoke", evidence_ref: "fixture:mapping-revoked-during-assessment",
      reason: "CI sensor/source mapping revoked after assessment operation claim" }));
  assert.equal(mappingRevokedDuringOperation.response.status, 201,
    JSON.stringify(mappingRevokedDuringOperation.body));
  assert.equal(mappingRevokedDuringOperation.body.data.status, "revoked");
  const mappingDeniedAssessment = await operationRequest(mappingOperationPath + "/complete",
    "ci-human-subject", "POST", {
      expected_lease_version: mappingClaim.body.data.lease_version,
      expected_lease_request_id: mappingClaim.body.data.lease_request_id,
    });
  assert.equal([200, 201].includes(mappingDeniedAssessment.response.status), true,
    JSON.stringify(mappingDeniedAssessment.body));
  assert.equal(mappingDeniedAssessment.body.data.status, "not_assessed");
  assert.equal(mappingDeniedAssessment.body.data.reason_code, "verified_sensor_mapping_missing");

  // Source lifecycle revocation after claim must produce a durable
  // not_assessed result, even though the observation and lease were valid.
  const sourceOperationPath = "/api/v1/tenants/tenant-http-a/observations/obs-http-source-revocation/measurement-assessment-operations";
  const sourceOperation = await operationRequest(sourceOperationPath, "ci-human-subject");
  assert.equal(sourceOperation.response.status, 201, JSON.stringify(sourceOperation.body));
  const sourceOperationRoute = "/api/v1/tenants/tenant-http-a/measurement-assessment-operations/" +
    sourceOperation.body.data.operation_id;
  const sourceOperationClaim = await operationRequest(sourceOperationRoute + "/claim", "ci-human-subject");
  assert.equal(sourceOperationClaim.response.status, 200, JSON.stringify(sourceOperationClaim.body));
  const sourceRevokedDuringOperation = await throughGateway(
    "/api/v1/tenants/tenant-http-a/sites/site-http-a/sources/source-http-a/verification",
    accessToken("ci-measurement-reviewer"), { "content-type": "application/json" }, "POST",
    JSON.stringify({ decision: "revoke", evidence_ref: "fixture:source-revoked-during-assessment",
      reason: "CI source revoked after assessment operation claim" }));
  assert.equal(sourceRevokedDuringOperation.response.status, 201,
    JSON.stringify(sourceRevokedDuringOperation.body));
  assert.equal(sourceRevokedDuringOperation.body.data.status, "revoked");
  const sourceDeniedAssessment = await operationRequest(sourceOperationRoute + "/complete", "ci-human-subject", "POST", {
    expected_lease_version: sourceOperationClaim.body.data.lease_version,
    expected_lease_request_id: sourceOperationClaim.body.data.lease_request_id,
  });
  assert.equal([200, 201].includes(sourceDeniedAssessment.response.status), true,
    JSON.stringify(sourceDeniedAssessment.body));
  assert.equal(sourceDeniedAssessment.body.data.status, "not_assessed");
  assert.equal(sourceDeniedAssessment.body.data.reason_code, "source_not_active_or_verified");

  const grantRevocation = await siteGrant("ci-human-subject", {
    action: "revoke", subject: "ci-invited-human", site_id: "site-http-a",
    grant_action: "read", reason: "CI revoke assessment operation access",
  });
  assert.equal(grantRevocation.response.status, 200, JSON.stringify(grantRevocation.body));
  const revokedGrantRead = await operationRequest(revokedGrantPath, "ci-invited-human", "GET");
  assert.equal(revokedGrantRead.response.status, 404);
  const revokedGrantClaim = await operationRequest(revokedGrantPath + "/claim", "ci-invited-human");
  assert.equal(revokedGrantClaim.response.status, 404);



  // Revoke site authorization after a lease is acquired but before completion.
  // The completion boundary must re-check authorization and must not insert
  // an assessment merely because the operation was previously claimed.
  const inFlightGrant = await siteGrant("ci-human-subject", {
    action: "grant", subject: "ci-invited-human", site_id: "site-http-a",
    grant_action: "read", reason: "CI in-flight completion authorization",
  });
  assert.equal(inFlightGrant.response.status, 201, JSON.stringify(inFlightGrant.body));
  const inFlightPath = "/api/v1/tenants/tenant-http-a/observations/obs-http-grant/measurement-assessment-operations";
  const inFlightReserve = await operationRequest(inFlightPath, "ci-invited-human");
  assert.equal(inFlightReserve.response.status, 201, JSON.stringify(inFlightReserve.body));
  const inFlightId = inFlightReserve.body.data.operation_id;
  const inFlightOperationPath = "/api/v1/tenants/tenant-http-a/measurement-assessment-operations/" + inFlightId;
  const inFlightClaim = await operationRequest(inFlightOperationPath + "/claim", "ci-invited-human");
  assert.equal(inFlightClaim.response.status, 200, JSON.stringify(inFlightClaim.body));
  const inFlightRevoke = await siteGrant("ci-human-subject", {
    action: "revoke", subject: "ci-invited-human", site_id: "site-http-a",
    grant_action: "read", reason: "CI revoke access before assessment completion",
  });
  assert.equal(inFlightRevoke.response.status, 200, JSON.stringify(inFlightRevoke.body));
  const deniedCompletion = await operationRequest(inFlightOperationPath + "/complete", "ci-invited-human", "POST", {
    expected_lease_version: inFlightClaim.body.data.lease_version,
    expected_lease_request_id: inFlightClaim.body.data.lease_request_id,
  });
  assert.equal(deniedCompletion.response.status, 404, JSON.stringify(deniedCompletion.body));
  const racedTerminal = await operationRequest(successorRoute, "ci-human-subject", "GET");
  assert.equal(racedTerminal.response.status, 200, JSON.stringify(racedTerminal.body));
  assert.equal(racedTerminal.body.data.state, "not_assessed");
  assert.equal(racedTerminal.body.data.events.filter(event => event.event_type === "claimed").length, 1);
  assert.equal(racedTerminal.body.data.events.filter(event => event.event_type === "lease_renewed").length, 1);
  assert.equal(racedTerminal.body.data.events.filter(event => event.event_type === "not_assessed").length, 1);

  // This integrated run inherits the preceding source, calibration, policy,
  // and sensor/source-mapping revocation scenarios from the base branch.
  // Site lifecycle must be governed through the public gateway and must not
  // erase or strand an assessment operation that was already claimed.
  const siteLifecycleActionPath = "/api/v1/tenants/tenant-http-a/sites/site-http-a/lifecycle-actions";
  const siteLifecycleEventsPath = "/api/v1/tenants/tenant-http-a/sites/site-http-a/lifecycle-events";
  const inactiveSiteOperationReserve = await operationRequest(
    "/api/v1/tenants/tenant-http-a/observations/obs-http-grant/measurement-assessment-operations",
    "ci-human-subject");
  assert.equal(inactiveSiteOperationReserve.response.status, 201,
    JSON.stringify(inactiveSiteOperationReserve.body));
  const inactiveSiteOperationPath = "/api/v1/tenants/tenant-http-a/measurement-assessment-operations/" +
    inactiveSiteOperationReserve.body.data.operation_id;
  const inactiveSiteClaim = await operationRequest(inactiveSiteOperationPath + "/claim", "ci-human-subject");
  assert.equal(inactiveSiteClaim.response.status, 200, JSON.stringify(inactiveSiteClaim.body));

  const deniedSiteLifecycle = await throughGateway(siteLifecycleActionPath, accessToken("ci-invited-human"),
    { "content-type": "application/json", "Idempotency-Key": "site-lifecycle-denied" },
    "POST", JSON.stringify({ action: "deactivate", reason: "Viewer cannot change site lifecycle" }));
  assert.equal(deniedSiteLifecycle.response.status, 404);

  const immutableAssessmentBeforeSiteChange = await operationRequest(operationReadPath,
    "ci-human-subject", "GET");
  assert.equal(immutableAssessmentBeforeSiteChange.response.status, 200,
    JSON.stringify(immutableAssessmentBeforeSiteChange.body));
  assert.equal(immutableAssessmentBeforeSiteChange.body.data.state, "not_assessed");
  const immutableAssessmentId = immutableAssessmentBeforeSiteChange.body.data.assessment.id;
  const immutableAssessmentReason = immutableAssessmentBeforeSiteChange.body.data.assessment.reason_code;

  const siteDeactivated = await throughGateway(siteLifecycleActionPath, accessToken("ci-human-subject"),
    { "content-type": "application/json", "Idempotency-Key": "site-lifecycle-deactivate-1" },
    "POST", JSON.stringify({ action: "deactivate", reason: "CI active operation deactivation race" }));
  assert.equal(siteDeactivated.response.status, 201, JSON.stringify(siteDeactivated.body));
  assert.equal(siteDeactivated.body.data.previous_status, "active");
  assert.equal(siteDeactivated.body.data.new_status, "inactive");

  const siteDeactivateReplay = await throughGateway(siteLifecycleActionPath, accessToken("ci-human-subject"),
    { "content-type": "application/json", "Idempotency-Key": "site-lifecycle-deactivate-1" },
    "POST", JSON.stringify({ action: "deactivate", reason: "CI active operation deactivation race" }));
  assert.equal(siteDeactivateReplay.response.status, 200, JSON.stringify(siteDeactivateReplay.body));
  assert.equal(siteDeactivateReplay.body.data.id, siteDeactivated.body.data.id);

  const siteLifecycleConflict = await throughGateway(siteLifecycleActionPath, accessToken("ci-human-subject"),
    { "content-type": "application/json", "Idempotency-Key": "site-lifecycle-deactivate-1" },
    "POST", JSON.stringify({ action: "deactivate", reason: "Changed intent must conflict" }));
  assert.equal(siteLifecycleConflict.response.status, 409);

  const siteHistoryInactive = await throughGateway(siteLifecycleEventsPath, accessToken("ci-human-subject"));
  assert.equal(siteHistoryInactive.response.status, 200, JSON.stringify(siteHistoryInactive.body));
  assert.equal(siteHistoryInactive.body.data.current_status, "inactive");
  assert.equal(siteHistoryInactive.body.data.events[0].event_type, "deactivated");

  // Simulate a browser reload after the lifecycle change: reserve the exact
  // same actor/tenant/observation operation again. Core must return the
  // existing server-owned operation without creating a new one, even though
  // the site is now inactive.
  const inactiveSiteReloadRecovery = await operationRequest(
    "/api/v1/tenants/tenant-http-a/observations/obs-http-grant/measurement-assessment-operations",
    "ci-human-subject");
  assert.equal(inactiveSiteReloadRecovery.response.status, 200,
    JSON.stringify(inactiveSiteReloadRecovery.body));
  assert.equal(inactiveSiteReloadRecovery.body.data.operation_id,
    inactiveSiteOperationReserve.body.data.operation_id);

  // The opposite race order is immutable too: an assessment committed before
  // deactivation remains the same historical result afterward.
  const immutableAssessmentAfterSiteChange = await operationRequest(operationReadPath,
    "ci-human-subject", "GET");
  assert.equal(immutableAssessmentAfterSiteChange.response.status, 200,
    JSON.stringify(immutableAssessmentAfterSiteChange.body));
  assert.equal(immutableAssessmentAfterSiteChange.body.data.state, "not_assessed");
  assert.equal(immutableAssessmentAfterSiteChange.body.data.assessment.id, immutableAssessmentId);
  assert.equal(immutableAssessmentAfterSiteChange.body.data.assessment.reason_code, immutableAssessmentReason);

  // The short CI-only lease expires naturally. An inactive site still allows
  // the same actor to recover the stale worker fence, but completion can only
  // persist the fixed not_assessed outcome.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const inactiveSiteRecoveredClaim = await operationRequest(inactiveSiteOperationPath + "/claim",
    "ci-human-subject");
  assert.equal(inactiveSiteRecoveredClaim.response.status, 200,
    JSON.stringify(inactiveSiteRecoveredClaim.body));
  assert.equal(inactiveSiteRecoveredClaim.body.data.lease_version,
    inactiveSiteClaim.body.data.lease_version + 1);
  const inactiveSiteCompletion = await operationRequest(inactiveSiteOperationPath + "/complete",
    "ci-human-subject", "POST", {
      expected_lease_version: inactiveSiteRecoveredClaim.body.data.lease_version,
      expected_lease_request_id: inactiveSiteRecoveredClaim.body.data.lease_request_id,
    });
  assert.equal([200, 201].includes(inactiveSiteCompletion.response.status), true,
    JSON.stringify(inactiveSiteCompletion.body));
  assert.equal(inactiveSiteCompletion.body.data.status, "not_assessed");
  assert.equal(inactiveSiteCompletion.body.data.reason_code, "site_inactive_at_completion");

  const inactiveOperationRead = await operationRequest(inactiveSiteOperationPath, "ci-human-subject", "GET");
  assert.equal(inactiveOperationRead.response.status, 200, JSON.stringify(inactiveOperationRead.body));
  assert.equal(inactiveOperationRead.body.data.state, "not_assessed");

  const siteReactivated = await throughGateway(siteLifecycleActionPath, accessToken("ci-human-subject"),
    { "content-type": "application/json", "Idempotency-Key": "site-lifecycle-reactivate-1" },
    "POST", JSON.stringify({ action: "reactivate", reason: "CI explicit site reactivation" }));
  assert.equal(siteReactivated.response.status, 201, JSON.stringify(siteReactivated.body));
  assert.equal(siteReactivated.body.data.previous_status, "inactive");
  assert.equal(siteReactivated.body.data.new_status, "active");

  const siteHistoryReactivated = await throughGateway(siteLifecycleEventsPath, accessToken("ci-human-subject"));
  assert.equal(siteHistoryReactivated.response.status, 200, JSON.stringify(siteHistoryReactivated.body));
  assert.equal(siteHistoryReactivated.body.data.current_status, "active");
  assert.equal(siteHistoryReactivated.body.data.events.length, 2);
  assert.equal(siteHistoryReactivated.body.data.events.some(event => event.event_type === "deactivated"), true);
  assert.equal(siteHistoryReactivated.body.data.events.some(event => event.event_type === "reactivated"), true);

  console.log("Local D1 configuration persistence integration passed: transactional authorization, v1–v5 sequencing under concurrent distinct keys, exact replay, concurrent idempotency race, conflicting-key rejection, audit/review consistency and late-statement rollback");
  console.log("Wrangler multi-Worker Service Binding + local D1 integration passed: signed RS256 JWT via test-only JWKS fixture, actual gateway-to-private-Worker Service Binding, authorized resource read, tenant-scoped criteria list/version reads, tenant-admin draft create, reviewer assignment/revocation, site-scoped human observation verification, independent ingestion-actor checks, auditable verification revocation and persisted registry resolution and sample comparison, cross-tenant denial, missing grant, invalid JWT rejection, caller trust-header/cookie isolation");
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
