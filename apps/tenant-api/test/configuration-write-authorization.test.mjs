import test from "node:test";
import assert from "node:assert/strict";
import { authorizeConfigurationWrite } from "../src/configuration-write-authorization.mjs";

const membership = (role = "tenant_admin", overrides = {}) => ({
  subject: "user-1", tenant_id: "tenant-a", role,
  membership_status: "active", tenant_status: "active", ...overrides,
});
const grant = (overrides = {}) => ({
  subject: "user-1", tenant_id: "tenant-a", resource_type: "site",
  resource_id: "site-a", action: "create", ...overrides,
});
const assess = (m = [membership()], g = [grant()], overrides = {}) =>
  authorizeConfigurationWrite({
    principalSubject: "user-1", tenantId: "tenant-a", siteId: "site-a",
    membershipRows: m, grantRows: g, ...overrides,
  });

test("permits exactly one active admin membership with exact site create grant", () => {
  assert.deepEqual(assess(), { allowed: true, reason: "authorized" });
});
test("fails closed on absent, duplicate, mismatched or inactive membership", () => {
  for (const rows of [[], [membership(), membership()], [membership("tenant_admin",{tenant_id:"tenant-b"})],
    [membership("tenant_admin",{membership_status:"suspended"})],
    [membership("tenant_admin",{tenant_status:"suspended"})]]) {
    assert.equal(assess(rows).allowed, false);
  }
});
test("role ceiling prevents operators, analysts, viewers and service principals creating configs", () => {
  for (const role of ["operator","analyst","viewer","service"]) {
    assert.equal(assess([membership(role)]).allowed, false);
  }
});
test("requires one exact tenant/site/action grant and rejects wildcard or duplicate grants", () => {
  for (const rows of [[], [grant({tenant_id:"tenant-b"})], [grant({resource_id:"site-b"})],
    [grant({resource_type:"tenant"})], [grant({action:"update"})],
    [grant({resource_id:"*"})], [grant(),grant()]]) {
    assert.equal(assess([membership()], rows).allowed, false);
  }
});
test("rejects caller-selected alternate actions and malformed principal scope", () => {
  assert.equal(assess([membership()], [grant()], {action:"update"}).allowed, false);
  assert.equal(authorizeConfigurationWrite({
    principalSubject:"",tenantId:"tenant-a",siteId:"site-a",
    membershipRows:[membership()],grantRows:[grant()],
  }).allowed, false);
});
