// Test-only entrypoint: keeps the real JWT verifier but supplies a deterministic local JWKS fixture.
import { createGateway } from "./index.mjs";
import { verifyHumanAccessToken } from "./human-access-auth.mjs";
import { jwksDocument } from "../test/jwks-fixture.mjs";

export default createGateway({
  verifyAccessToken: (token, config) => verifyHumanAccessToken(
    token, config, undefined,
    async () => new Response(JSON.stringify(jwksDocument), {
      headers: { "content-type": "application/json" },
    }),
  ),
});
