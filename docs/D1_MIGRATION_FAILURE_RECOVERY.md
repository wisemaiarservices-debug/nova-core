# D1 migration failure and recovery runbook

**Status:** operational guidance for the proposed tenant migration stack. No D1 database is currently provisioned and this runbook does not authorize a remote migration or production release.

## Recovery model

Use Wrangler's D1 migration runner (`wrangler d1 migrations apply`) for schema migrations. Cloudflare documents that if a migration fails, that migration is rolled back and the previous successful migration remains applied. Migrations are tracked by filename in the database's `d1_migrations` table and are applied in filename order.

This is a **per-migration failure boundary**, not a whole-command rollback: earlier migrations that completed successfully remain applied if a later migration fails. Do not assume that the database returns to the state before the entire command.

The D1 migration runner captures a backup after an apply run. That is useful recovery evidence, but it is not a substitute for the separately verified pre-change backup/export required by the tenant persistence preflight.

## Before any shared or production application

1. Confirm the exact account, environment, D1 database name, and immutable database ID against the approved deployment configuration. Always pass an explicit target/environment; never rely on an implicit local/remote default.
2. Capture a pre-change backup/export and verify that it can be read and restored to an isolated database. Record its timestamp and target identity.
3. Run `wrangler d1 migrations list <DATABASE> --remote` (or the explicit intended environment) and record the applied and pending migration filenames. Do not infer migration state from Worker deployment state.
4. Review the exact pending SQL in lexicographic order. Test the complete chain against a disposable D1-compatible database with representative legacy rows, foreign keys, triggers, and expected tenant ownership mappings.
5. Confirm the Worker version being deployed is compatible with both the pre-migration and post-migration schema during the rollout window.
6. Obtain the required explicit release approval. A successful local SQLite test or Wrangler local dry-run is not evidence of a successful remote D1 application.

## If an apply command fails

1. Stop the release. Do not deploy code that assumes the failed schema change exists.
2. Preserve the full Wrangler output, command, environment, target database ID, timestamp, and exact migration filenames involved. Do not include credentials in the incident record.
3. Re-run `wrangler d1 migrations list <DATABASE> --remote` against the same explicit target. Compare the result with the preflight record to identify which earlier migrations completed and which migration remains pending.
4. Treat the failing migration as rolled back only in accordance with Wrangler's documented migration-runner behavior. Verify the schema state with read-only inspection before retrying; do not infer rollback from the process exit code alone.
5. Diagnose the SQL/runtime/compatibility issue in a disposable copy. If the failed migration is still pending and has not been applied, correct it through the normal reviewed change process, then retest the entire pending chain. Never modify a migration that is already recorded as applied.
6. Resume only after the failed migration's cause is fixed, the pending list and schema state are understood, and the release gates are re-approved.

## If an already-applied migration is wrong

Do not edit or replay the historical migration and do not invent a generic down migration. Add a new, forward-only corrective migration with a new ordered filename, test it against a copy of the affected schema and representative data, and review its compatibility with the currently deployed Worker.

A data/schema restore from a pre-change backup or D1 Time Travel is a separate, potentially destructive recovery decision. First determine the required recovery point, data-loss window, and effects on writes made after that point. Restore only to an isolated database for validation before any approved cutover. Do not overwrite a live database as an automatic response to a failed migration.

## NOVA Core tenant-specific safeguards

- The tenant stack currently contains migrations `0001` through `0015`; the complete local ordered-chain test does not establish remote D1 behavior.
- Migration `0002_tenant_isolation.sql` deliberately does not assign ownership to legacy rows. NULL-tenant legacy rows must remain inaccessible to tenant-scoped APIs until an authoritative, separately approved mapping is supplied.
- Migration `0005_nonce_jti_not_null.sql` deletes only NULL-JTI nonce rows before rebuilding the nonce table. Preserve and verify a pre-change backup and inspect nonce counts/validity in the isolated rehearsal.
- Do not disable tenant, audit-history, foreign-key, or replay-protection guards to make a migration succeed.
- Do not run individual SQL files through `wrangler d1 execute` as a substitute for the migration runner; that bypasses migration tracking and its documented failure handling.
- Record the final applied migration list, database identity, backup evidence, Worker version, and validation results in the release record.

## Current release decision

Production remains **HOLD**. The Cloudflare account inventory currently has no D1 database, so there is no remote target on which to claim migration success or failure-recovery validation. This runbook is documentation only; it creates no database, applies no migration, and changes no production configuration.

## References

- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Wrangler D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/)
