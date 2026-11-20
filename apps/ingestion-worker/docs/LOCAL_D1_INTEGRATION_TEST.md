# Ingestion Worker local D1 integration test

This harness runs only in GitHub CI against the disposable local D1 database already
created and seeded by `apps/tenant-api`'s D1 integration steps.

## What it verifies

- Site, source and asset ownership are resolved from actual local D1 rows.
- A valid synthetic observation is persisted with the server-derived tenant ID.
- The observation remains `unverified`; ingestion does not confer scientific or
  operational verification.
- An exact retry returns the same observation ID and leaves one audit event.
- Reusing the idempotency key with a changed payload returns a conflict and
  preserves the original row.
- Cross-tenant site and asset references are denied without persistence.
- A test-only SQLite trigger rejects the audit insert; the D1 batch must roll
  back the observation insert as well and the Worker must not report acceptance.

## Deliberate boundary

`wrangler.local-d1-test.toml` selects a CI-only entrypoint and a local D1 binding.
The entrypoint is not the production ingestion Worker entrypoint and exposes only
`/__ci/ingestion/*` routes when `CI_TEST_INGESTION=true`.

This harness intentionally bypasses Access JWT and service-grant verification.
Those controls remain covered by `test/worker.test.mjs` at the production Worker
handler boundary. The combined evidence is therefore: authenticated handler
behavior with a D1 test double, plus ownership/persistence/atomicity against real
disposable local D1. It is not an end-to-end Access/JWKS-to-D1 runtime test.

Never run this configuration with `--remote`, never deploy this entrypoint, and
never point it at a non-CI database. The UUID in the local Wrangler config is a
placeholder used only by Wrangler's local D1 emulator.
