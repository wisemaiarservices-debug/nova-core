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

1. Confirm the intended Cloudflare account remains on Workers Free and review current quotas.
2. Create a narrowly scoped deployment token only after explicit authorization; never paste credentials into source code or chat.
3. Configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets and review the `nova-core-api` GitHub Environment protection rules.
4. The workflow `.github/workflows/cloudflare-worker-deploy.yml` has both `workflow_dispatch` and a push trigger for the named feature branch. Its job-level condition permits deployment on manual dispatch, or on a matching push whose commit message contains `deploy-nova-core`. A push or PR by itself does not necessarily deploy.
5. Before a manual dispatch or qualifying push, review the exact commit, environment approvals, account plan and deployment target. Do not use this workflow for the private tenant API or gateway.
6. After an explicitly approved public API deployment, verify its health endpoint and register its URL only as the public Core API—not as the private tenant gateway.

## Separate private tenant API and gateway

The private Workers are distinct from the public Python Core API. The checked-in workflow above deploys only `apps/api`; it does **not** deploy `apps/tenant-api` or `apps/tenant-gateway`.

The tenant API and gateway Wrangler configs disable `workers_dev` and preview URLs. The tenant API has no public route; the gateway references it only through the `TENANT_API` Service Binding. Their required D1, Access, issuer/audience, HMAC secret and protected hostname configuration is intentionally absent from source. No dedicated deployment workflow or verified remote Cloudflare setup is currently evidenced for those two Workers.

Do not publish a public Worker URL for the private tenant API, attach an unprotected route, reuse the public Python Core API as a gateway, or provision D1/secrets/Access policies without separate review and explicit authorization. The local workerd/Miniflare integration is not remote Cloudflare acceptance.

## Runtime notes

- NASA POWER retrieval uses the Workers Fetch API through Python Workers' JavaScript FFI when running on Pyodide; local CPython uses the existing urllib adapter.
- NASA POWER data remain gridded/model-derived data, not local station telemetry.
- Health checks prove service reachability only.
- No training runner, durable site database, autonomous dispatch or critical infrastructure control is included.
