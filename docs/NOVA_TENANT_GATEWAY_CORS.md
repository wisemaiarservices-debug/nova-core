# NOVA Core tenant gateway — browser CORS configuration

The tenant gateway accepts credentialed browser requests only from exact origins listed in the non-secret `CORS_ALLOWED_ORIGINS` Worker variable.

## Configure

Set `CORS_ALLOWED_ORIGINS` as a comma-separated list of complete origins, with scheme and host only. Example format:

```text
https://nova-os-pied.vercel.app,https://nova-command-center-peach.vercel.app
```

Use the exact deployed NOVA OS and Engineering Console origins that need browser access. Add a preview origin only when it is specifically required; remove it when no longer used. Do not use `*`, paths, wildcards or untrusted preview domains. Invalid entries are ignored.

## Browser contract

- Preflight: `OPTIONS` is handled without forwarding to the private Tenant API.
- Allowed methods: `GET`, `POST`.
- Allowed request headers: `Accept`, `Content-Type`.
- Credentialed requests: `Access-Control-Allow-Credentials: true` with the exact requesting origin.
- Exposed response header: `X-Request-Id`, required by clients to correlate and validate Core responses.
- Responses use `Cache-Control: no-store` and vary on Origin; preflight responses also vary on requested method and headers.
- Actual API requests still require Cloudflare Access JWT verification, signed internal identity forwarding, tenant membership and exact resource grants. CORS is not authentication or authorization.

## Cloudflare Access deployment check

The Access application must allow the browser's preflight OPTIONS request to reach the gateway while continuing to protect the actual GET/POST request with the Access session. Verify this behavior on the configured Access hostname before enabling the frontend integration. Do not make the actual API routes public to solve preflight.

No production origin is assumed or configured by this change. The Worker variable must be set to the exact approved deployment origins as a separate reviewed configuration action.
