# NOVA Core isolated ingestion Worker — Cloudflare setup runbook

## Current status

The Worker source is in `apps/ingestion-worker/`, but it has not been deployed. No Cloudflare Access application, Service Auth policy, service token, environment variables, or D1 binding has been created. The existing public NOVA Core API is not changed by this runbook.

Do not attach the existing `nova-core-api` Worker to a service-token-only Access application. Its public health and NASA POWER read endpoints are used by browser dashboards.

## Intended free-tier deployment shape

- Worker name: `nova-core-ingest-api`
- Expected workers.dev hostname after deployment: `nova-core-ingest-api.neohaven.workers.dev` (verify the actual hostname in Cloudflare)
- Public read-only API remains: `nova-core-api.neohaven.workers.dev`
- No D1 binding in this first deployment.
- The ingestion POST route returns `503 storage_not_configured` even after successful authentication. It does not accept or store data.

Cloudflare Access and Workers have free-plan limits. Check the account's current plan, quotas, and billing settings before creating resources. Do not enable paid features, upgrades, or usage commitments.

## Deploy the isolated Worker

1. In the repository, open `apps/ingestion-worker/`.
2. Deploy with Wrangler using the existing Cloudflare account and an API token restricted to the required Workers deployment permissions. The deployment config is `wrangler.jsonc`.
3. Confirm the deployment output's actual `workers.dev` hostname. Do not assume the example hostname if Cloudflare assigns a different one.
4. Test only `GET /health`. It should identify `nova-core-ingest-api` and report `authenticated-ingestion-disabled`.
5. Do not expose this endpoint to module frontends or register it as an operational API yet.

## Protect the dedicated hostname with Cloudflare Access

1. In Cloudflare Zero Trust, open **Access controls → Applications** and add a self-hosted application for the exact ingestion Worker hostname from the deployment output.
2. Create a policy with action **Service Auth**. Include only the intended service token identities. Do not add broad Everyone, email-domain, or bypass rules.
3. Confirm there is no overlapping Allow or Bypass policy that admits ordinary users.
4. Keep the existing public NOVA Core API hostname outside this Access application.
5. Test the Worker hostname without service-token credentials: Access must deny the request before the Worker handles it.

## Configure Worker-side verification variables

In the ingestion Worker settings, add server-side variables (not browser variables):

- `ACCESS_ISSUER`: exact Cloudflare Access team issuer, for example `https://<team-name>.cloudflareaccess.com`.
- `ACCESS_AUDIENCE`: the Access application's exact AUD tag.
- `NOVA_SERVICE_GRANTS_JSON`: exact service-token client ID to module/source allowlist.

Example allowlist shape (replace every placeholder with a real source ID before use):

```json
{
  "REPLACE_WITH_SERVICE_TOKEN_CLIENT_ID": {
    "neoagro": ["REPLACE_WITH_REGISTERED_SOURCE_ID"]
  }
}
```

These are Worker-side configuration values. The Client Secret is never stored in this Worker: the calling module backend sends the Client ID and Client Secret to Cloudflare Access, and Access sends a signed JWT assertion to the Worker. Never place a service-token secret in a browser, `NEXT_PUBLIC_*` variable, repository, logs, or NOVA OS local storage.

## Acceptance tests before any database integration

- Request without service-token credentials is denied by Access.
- Request with a valid service token reaches the Worker and is still rejected with `503 storage_not_configured`.
- Wrong issuer, audience, signature, expiry, or service-token claims are rejected by the Worker.
- An authenticated service with the wrong module/source grant is rejected with `403`.
- The existing public NOVA Core API health and NASA POWER endpoints remain publicly readable.
- No observation row is created; there is no D1 binding in this phase.

## Stop conditions

Stop before creating any D1 database or binding. Stop if Cloudflare indicates a paid feature, account upgrade, or non-zero usage commitment is required. Do not create a real service token until the Access application and policy are reviewed and the calling backend is ready to store its secret securely.

The next implementation gate after this runbook is a live Cloudflare Access integration test, followed by D1 adapter tests and verified atomic observation-plus-audit persistence. Only then should a write route be considered.
