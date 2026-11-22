# Source rights cutover implementation plan v1

**Status:** implementation complete in source; independent review and staging impact assessment remain outstanding.

**Implementation basis:** PR #311 head `873086ea07779f349d47480847e3962a9ff4f9a0`. The original proposal below is retained as a record of the intended design; migration 0064 and its local D1 tests are now implemented.

## Verified implementation and CI

- Migration: `apps/api/migrations/0064_source_data_rights_capability_observation_guards.sql`.
- Exact-head workflow run [44966562811](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44966562811) passed all three jobs.
- The Tenant Worker job applied ordered migrations through 0064 to disposable local D1 and passed the source-rights capability-approval and observation-insert guard tests, plus the existing capability, calibration, observation, gateway and quality-flag tests.
- Positive and negative evidence included exact-scope capability approval, valid observation acceptance, missing storage-purpose rejection, unresolved rights-reference rejection, mismatched evidence rejection, and rejection of new observations after rights revocation or evidence revocation.

CI proves the tested source and disposable local D1 behavior only. It does not prove that any remote D1 has applied these migrations or that a deployed Worker is running this code.

## Enforced D1 boundaries

Migration 0064 adds two independent `BEFORE INSERT` guards:

1. **Capability approval** on `source_capability_events`, for `event_type='approved'`. It resolves `source_capabilities.data_rights_ref` to the exact rights declaration and requires tenant/site/source and NULL-safe asset equality; current approved rights state; current rights effective window; exact supporting evidence ID, digest and scope; capability `evidence_ref` equal to the supporting document ID; current verified evidence state and effective window; and explicit `measurement_ingestion` plus `storage` purposes.
2. **Observation insertion** on `observations`. It independently rechecks the same rights/evidence chain against the observation's exact capability scope at insert time. Rights revocation or evidence withdrawal therefore blocks future observations without rewriting historical rows.

Analytics and model-training permissions are not inferred from ingestion or storage. Existing migration 0055 handling retains precedence for missing capability identity and capability scope mismatch; migration 0064 evaluates rights only when an exact scoped capability exists.

## Test fixture and coverage status

The deterministic synthetic evidence/rights fixture helper and fixture conversions were completed before enabling migration 0064. The CI workflow seeds synthetic rights/evidence chains before approved capability and observation fixtures.

The D1 suite covers:
- exact positive capability approval and observation insertion;
- missing storage purpose;
- unresolved rights reference;
- mismatched supporting evidence;
- rights revocation blocking future observations;
- evidence revocation blocking future observations;
- existing observation identity, capability scope, calibration, lifecycle and quality-flag boundaries.

The local tests are not a substitute for independent review or remote staging evidence.

## Independent-review handoff

The reviewer must be independent of the implementation and should inspect the exact PR head, not a moving branch. Review scope:
- exact tenant/site/source/NULL-safe asset equality across capability, rights declaration, evidence and observation;
- latest-event semantics and append-only lifecycle assumptions;
- rights and evidence effective-window boundaries;
- evidence ID/digest binding and capability evidence reference;
- explicit purpose checks and non-inference of analytics/model training;
- precedence and compatibility with migration 0055;
- revocation and idempotency interactions;
- preservation of historical observation rows;
- migration ordering, trigger behavior and adversarial test adequacy.

Record findings against the exact commit SHA. Any change after review requires re-review of the changed code and a new exact-head CI run.

## Read-only staging impact assessment

The aggregate-only inventory is `apps/tenant-api/scripts/read-only-source-rights-impact-inventory.sql`. It must first be run against a disposable local D1 copy. A remote staging run is a separate operation and requires explicit authorization plus verified staging database identity and read-only credentials/access.

Before any remote run:
1. Identify the exact staging account, database name/ID, environment and tenant-data classification from authoritative configuration.
2. Obtain written authorization limited to read-only aggregate queries.
3. Confirm the execution path cannot target production and cannot issue writes or migrations.
4. Capture the exact inventory script commit SHA and query output; do not export tenant names, source names, document bytes, raw telemetry, credentials or secrets.
5. Have the independent reviewer inspect the output and classify records that would fail migration 0064.
6. Resolve legacy records only through an approved product/legal policy; do not silently grandfather, rewrite or backfill them.

The inventory must distinguish present-day rights/evidence compliance from historical observation age. It does not decide retroactive authorization or whether historic processing was lawful.

## Safe rollout sequence

1. Fixture conversion and local validation — complete.
2. Migration 0064 and adversarial local D1 tests — complete.
3. Independent review of exact PR head — pending.
4. Explicitly authorized, aggregate-only staging impact inventory — pending.
5. Product/legal decision for any legacy records and historical observations — pending.
6. Separate staging migration authorization, deployment authorization and rollback plan — not granted by this document.

## Explicit non-actions and limits

No remote D1 migration, remote staging inventory, Worker deployment, PR merge, secret change, customer notification or paid resource was performed or authorized. PR #311 remains draft/open/unmerged unless separately verified otherwise. No independent security review or production readiness is claimed.
