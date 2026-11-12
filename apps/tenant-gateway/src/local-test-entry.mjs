// Test-only entrypoint: routes JWKS retrieval through a local Service Binding.
import { createGateway } from "./index.mjs";
import { verifyHumanAccessToken } from "./human-access-auth.mjs";

export default createGateway({
  verifyAccessToken: (token, config, env) => verifyHumanAccessToken(
    token, config, undefined,
    (url, init) => env.ACCESS_JWKS.fetch(new Request(url, init)),
  ),
});
