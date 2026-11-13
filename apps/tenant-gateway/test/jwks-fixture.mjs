// Public half of a disposable CI-only RSA keypair. Never use outside local tests.
const jwk = {
  kty: "RSA",
  n: "4a2mKnCw6tR4-1EU6IYXFmKwbvzp-G28bTC4uIiRJRaeA72GFwGPh_iPZJBMzMsl_W0K4AZ2E8-ORbBoc-Vub7zHV2SPLWQLk4taPE9qr4na4ZA2OZ_2lbXtdcEgH2kmeTpMudP4zYj7vUenPiHlbZkBHdDqCIVpetwfr6mfPQV3Gh7sKlarbuloOGODNKBEWNGfCjHGdpCSGEXwj8qnCSRgBfj9pRlYsyk84ehzUbZbtcPndy_yRjeL2zHZB-woX0ULcS_TCAg8w6mPUm4jPDZOyy-Fy606eAX79Tw51gB3n1Exy942FfceiqQrae32VV4Cx_G5hsMIdkeb3o9j1w",
  e: "AQAB",
  kid: "nova-local-ci-key",
  use: "sig",
  alg: "RS256",
};
export const jwksDocument = { keys: [jwk] };
export default {
  fetch() {
    return new Response(JSON.stringify(jwksDocument), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  },
};
