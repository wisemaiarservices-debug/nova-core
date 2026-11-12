import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const tenantConfig = new URL("../../tenant-api/wrangler.toml", import.meta.url);
const gatewayConfig = new URL("../wrangler.toml", import.meta.url);

test("tenant API remains private and has no alternate public ingress", async () => {
  const config = await readFile(tenantConfig, "utf8");
  assert.match(config, /^name = "nova-core-tenant-api"$/m);
  assert.match(config, /^workers_dev = false$/m);
  assert.match(config, /^preview_urls = false$/m);
  assert.doesNotMatch(config, /^\s*(?:route|routes|workers_dev_domain|workers_dev_domain_enabled|custom_domain|zone_name)\s*=/m);
  assert.doesNotMatch(config, /^\s*\[\[services\]\]/m);
});

test("gateway has only the intended private tenant API Service Binding", async () => {
  const config = await readFile(gatewayConfig, "utf8");
  assert.match(config, /^name = "nova-core-tenant-gateway"$/m);
  assert.match(config, /^workers_dev = false$/m);
  assert.match(config, /^preview_urls = false$/m);
  assert.doesNotMatch(config, /^\s*(?:route|routes|workers_dev_domain|workers_dev_domain_enabled|custom_domain|zone_name)\s*=/m);
  const bindings = [...config.matchAll(/^\[\[services\]\]$/gm)];
  assert.equal(bindings.length, 1);
  assert.match(config, /^binding = "TENANT_API"$/m);
  assert.match(config, /^service = "nova-core-tenant-api"$/m);
});
