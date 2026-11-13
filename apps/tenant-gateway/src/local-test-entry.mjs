// Test-only entrypoint: keeps the real JWT verifier but supplies a deterministic local JWKS fixture.
import { createGateway } from "./index.mjs";
import { verifyHumanAccessToken } from "./human-access-auth.mjs";
import { jwksDocument } from "../test/jwks-fixture.mjs";

const gateway = createGateway({
  verifyAccessToken: (token, config) => verifyHumanAccessToken(
    token, config, undefined,
    async () => new Response(JSON.stringify(jwksDocument), {
      headers: { "content-type": "application/json" },
    }),
  ),
});


// CI-only proxy for the isolated configuration-write harness. This path is
// absent from the production gateway entrypoint and exists only in this local
// JWKS-fixture Worker configuration.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__ci/")) {
      if (!env.TENANT_API) return new Response("not_found", { status: 404 });
      return env.TENANT_API.fetch(new Request(
        "https://nova-core-tenant-api.internal" + url.pathname + url.search,
        request,
      ));
    }
    return gateway.fetch(request, env);
  },
};
