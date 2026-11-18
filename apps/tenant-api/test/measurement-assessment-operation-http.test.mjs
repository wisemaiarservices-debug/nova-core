import test from "node:test";
import assert from "node:assert/strict";
import { matchMeasurementAssessmentOperationRoute } from "../src/measurement-assessment-operation-http.mjs";

const base = "https://nova-core-tenant-api.internal";

test("reserve route is POST-only and resolves exact tenant and observation", () => {
  const url = new URL(base + "/internal/v1/tenants/tenant-1/observations/observation-1/measurement-assessment-operations");
  assert.deepEqual(matchMeasurementAssessmentOperationRoute(url, "POST"), {
    tenant: "tenant-1", observation: "observation-1", operation: null, action: "reserve",
  });
  assert.equal(matchMeasurementAssessmentOperationRoute(url, "GET"), null);
});

test("operation read route is GET-only", () => {
  const url = new URL(base + "/internal/v1/tenants/tenant-1/measurement-assessment-operations/operation-1");
  assert.deepEqual(matchMeasurementAssessmentOperationRoute(url, "GET"), {
    tenant: "tenant-1", observation: null, operation: "operation-1", action: "read",
  });
  assert.equal(matchMeasurementAssessmentOperationRoute(url, "POST"), null);
});

test("claim, renew and complete routes are POST-only", () => {
  for (const action of ["claim", "renew", "complete"]) {
    const url = new URL(base + "/internal/v1/tenants/tenant-1/measurement-assessment-operations/operation-1/" + action);
    assert.deepEqual(matchMeasurementAssessmentOperationRoute(url, "POST"), {
      tenant: "tenant-1", observation: null, operation: "operation-1", action,
    });
    assert.equal(matchMeasurementAssessmentOperationRoute(url, "GET"), null);
  }
});

test("route matcher rejects query strings, fragments, malformed IDs and trailing path segments", () => {
  for (const suffix of ["?page=1", "#fragment", "/extra", "//"]) {
    const url = new URL(base + "/internal/v1/tenants/tenant-1/measurement-assessment-operations/operation-1" + suffix);
    assert.equal(matchMeasurementAssessmentOperationRoute(url, "GET"), null);
  }
  const invalid = new URL(base + "/internal/v1/tenants/../measurement-assessment-operations/op");
  assert.equal(matchMeasurementAssessmentOperationRoute(invalid, "GET"), null);
});
