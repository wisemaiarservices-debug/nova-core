// Test-only entrypoint: routes JWKS retrieval through a local Service Binding.
import { createGateway } from "./index.mjs";
import { verifyHumanAccessToken } from "./human-access-auth.mjs";

export default createGateway({
  verifyAccessToken: (token, config, env) => verifyHumanAccessToken(
    token, config, undefined,
    () => {
      if (!env.ACCESS_JWKS) throw new Error("local_access_jwks_binding_missing");
      return env.ACCESS_JWKS.fetch(new Request(
        "https://nova-core-access-jwks-fixture.internal/cdn-cgi/access/certs",
        { method: "GET", headers: { Accept: "application/json" } },
      ));
    },
  ),
});
