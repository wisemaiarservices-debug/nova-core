# NOVA Tenant Gateway browser access

The tenant gateway supports credentialed browser reads only for exact origins listed in the CORS_ALLOWED_ORIGINS Worker variable.

## Configuration

Set CORS_ALLOWED_ORIGINS to a comma-separated list of complete HTTPS origins, with no paths or trailing slash. Example format:

    https://nova-os.example.test,https://nova-command-center.example.test

Only add origins that are controlled by NeoHaven and approved for tenant-scoped data access. Never use * with credentials. Leave the variable unset until the intended frontend origins are confirmed.

The gateway rejects browser requests that include an Origin not in this allowlist. For approved origins it returns Access-Control-Allow-Origin with the exact origin, Access-Control-Allow-Credentials: true, Vary: Origin and exposes x-request-id. OPTIONS preflight is answered without invoking tenant data routes; allowed methods are GET, POST and OPTIONS, and allowed request headers are Accept and Content-Type.

Requests without an Origin continue to use the server-to-server path and receive no CORS headers. Cloudflare Access authentication and exact tenant/site grants remain mandatory for protected data requests. CORS is not authentication.

## Frontend contract

The browser client uses credentialed GET requests and the Cloudflare Access session. Configure VITE_NOVA_TENANT_GATEWAY_URL to the gateway HTTPS origin separately from the public Core health URL. The Access application must allow the approved frontend origin and support the browser's preflight behavior if non-simple requests are later introduced.

No origin is configured or deployed by this change. Production configuration must be completed and tested by an authorized operator before claiming browser connectivity.
