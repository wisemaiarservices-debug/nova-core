import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
const actorGuard = /EXISTS \(SELECT 1 FROM tenant_memberships actor_m WHERE actor_m\.tenant_id = \? AND actor_m\.subject = \? AND actor_m\.status = 'active' AND actor_m\.role IN \('tenant_owner', 'tenant_admin'\)\)/;

test("asset, source and observation grant INSERTs recheck the actor inside the D1 statement", () => {
  const start = source.indexOf("const RESOURCE_GRANT_INSERT_SQL = {");
  const end = source.indexOf("\n};", start);
  assert.ok(start >= 0 && end > start);
  const sql = source.slice(start, end);
  for (const type of ["asset", "source", "observation"]) {
    const line = sql.split("\n").find((entry) => entry.trimStart().startsWith(type + ":"));
    assert.ok(line, `missing ${type} grant SQL`);
    assert.match(line, actorGuard, `${type} grant must recheck active owner/admin membership`);
  }
  assert.match(source, /resourceId, tenant, tenant, actor\),/);
});

test("resource and site grant revocations recheck actor authority at mutation time", () => {
  const resourceDelete = source.match(/DELETE FROM tenant_resource_grants WHERE id = \? AND tenant_id = \? AND subject = \? AND resource_type = \? AND resource_id = \? AND action = \?([\s\S]*?)\n      \.bind\(grantId, tenant, body\.subject, type, resourceId, action, tenant, tenant, actor\)/);
  assert.ok(resourceDelete, "resource revoke must bind the authenticated actor into its SQL guard");
  assert.match(resourceDelete[1], actorGuard);

  const siteGrant = source.match(/INSERT INTO tenant_resource_grants \(id, tenant_id, subject, resource_type, resource_id, action\) SELECT[\s\S]*?resource_type = 'site'[\s\S]*?\n      \.bind\(grantId, tenant, body\.subject, body\.site_id, body\.grant_action,[\s\S]*?tenant, body\.subject, tenant, actor\)/);
  assert.ok(siteGrant, "site grant/revoke statements must bind the authenticated actor");
  assert.match(siteGrant[0], actorGuard);
});
