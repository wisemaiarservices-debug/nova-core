# Tenant nonce cleanup Worker

This is a separate, scheduled-only Python Worker for the durable assertion replay table.

## Runtime boundary

- No HTTP fetch handler, public route, workers.dev endpoint, Access application, or Service Binding.
- One D1 binding, TENANT_DB, is intended to point to the database containing internal_request_nonces.
- The configured schedule runs at minute 17 of each UTC hour.
- Each invocation performs exactly one parameterized delete of at most 500 rows whose retained_until is less than or equal to the scheduled event time.
- A backlog is left for a later invocation; the Worker does not loop, widen the batch, or delete rows based on assertion expiry alone.
- Missing bindings, malformed event times, unsuccessful D1 results, and storage errors fail the scheduled invocation closed.

## Deployment gate

The Wrangler configuration deliberately contains an all-zero placeholder D1 ID. It is a source-only configuration sentinel, not a provisioned database identifier. Replace it only in a separately approved environment-specific deployment configuration after the D1 database exists and migration 0003_internal_request_nonces.sql has been applied and verified. Do not deploy this placeholder configuration.

The local test suite uses fake D1 bindings and SQLite migration tests. It does not establish live D1 behavior or prove the scheduled Worker has been deployed.
