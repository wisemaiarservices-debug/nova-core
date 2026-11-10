# NOVA Core API — Cloudflare Workers deployment

## Status

This repository contains a Cloudflare Python Worker adapter for the existing FastAPI app. It is a deployment scaffold and local smoke test only. It has **not** been deployed to a Cloudflare account, and no account, billing plan, token or secret has been changed.

Cloudflare documents support for FastAPI through its Python Workers ASGI adapter. The Worker entrypoint is `apps/api/worker.py`; `wrangler.jsonc` enables the `python_workers` compatibility flag.

## Free-tier guardrails

The target is **Workers Free** only. Current documented limits include:

- 100,000 requests per day
- 10 ms CPU time per request
- 128 MB memory
- 50 subrequests per request
- 64 MiB Worker size

The Free plan rejects requests that exceed its limits; do not switch this account to Workers Paid or enable a paid usage model. Cloudflare currently lists Workers Paid at a minimum of USD $5/month. Review current limits before any production use. This V1 API is low-compute decision support, not a critical-control service.

## Local validation

From the repository root:

```bash
cd apps/api
uv sync --all-groups
uv run pywrangler dev --ip 127.0.0.1 --port 8787
```

Then test:

```bash
curl http://127.0.0.1:8787/health
curl -X POST http://127.0.0.1:8787/api/v1/recommendations/run \
  -H 'Content-Type: application/json' -d '{}'
```

GitHub Actions runs a local Worker smoke test for the health route, review-only recommendation route and OpenAPI schema.

## Deployment (manual; not yet authorized or executed)

1. Create or select a Cloudflare account and confirm it remains on Workers Free.
2. Create a scoped API token with permission to deploy Workers scripts to the intended account.
3. Store the token as a GitHub Actions secret named `CLOUDFLARE_API_TOKEN`; store the account identifier as `CLOUDFLARE_ACCOUNT_ID`. Never paste either value into source code or chat.
4. From `apps/api`, run `uv run pywrangler deploy` only after reviewing the account's plan and deployment settings.
5. Add the resulting API base URL to the Engineering Console API registry and verify `/health`.
6. Keep the exact production client origins in `NOVA_CORE_ALLOWED_ORIGINS`; do not use wildcard CORS.

## Runtime notes

- NASA POWER retrieval uses the Workers Fetch API through Python Workers' JavaScript FFI when running on Pyodide; local CPython uses the existing urllib adapter.
- NASA POWER data remain gridded/model-derived data, not local station telemetry.
- Health checks prove service reachability only.
- No training runner, durable site database, autonomous dispatch or critical infrastructure control is included.


A manual GitHub Actions workflow is available at `.github/workflows/cloudflare-worker-deploy.yml`. After configuring the two repository secrets and reviewing the `nova-core-api` GitHub Environment protection rules, use **Actions → Deploy NOVA Core API to Cloudflare Workers → Run workflow**. The workflow is manual-only; it is not triggered by pushes or pull requests.
