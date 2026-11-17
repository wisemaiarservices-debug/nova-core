# NOVA Core governed ingestion and assessment V1 — integration candidate

## Candidate

- Consolidated pull request: [#237](https://github.com/wisemaiarservices-debug/nova-core/pull/237)
- Parent integration base: [#229](https://github.com/wisemaiarservices-debug/nova-core/pull/229)
- Included stacked changes: [#231](https://github.com/wisemaiarservices-debug/nova-core/pull/231) through [#236](https://github.com/wisemaiarservices-debug/nova-core/pull/236)
- Source snapshot at candidate creation: `10659aebd639e8f66dfc327927d8a8e5293471f8`

This document describes a draft integration candidate, not a production release.

## Included controls

1. **Ingestion source guard (#231):** a new observation insert is rejected unless its exact source remains verified and matches the tenant, site, module and active-resource scope.
2. **Assessment source lifecycle (#232):** new assessments recheck that the source remains verified and correctly scoped.
3. **Mapping lifecycle (#233):** a mapping cannot be newly verified after its source or mapped resources become ineligible.
4. **Atomic governance transitions (#234):** mapping, calibration and quality-policy review events conditionally append only when the latest state and reviewer authority still permit the transition.
5. **Atomic assessment evidence gate (#235):** passed/failed assessment writes recheck the exact observation and current source, mapping, calibration and policy state at the final insert.
6. **Assessment idempotency (#236):** a request key is bound to its observation; cross-observation reuse conflicts, and same-observation retries return the immutable winner.

## Automated validation evidence

- #231 exact-head CI: `360905166e888ce005175b279175b4e28e6747f1`, run [44193036471](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44193036471).
- #232 exact-head CI: `0b6f6e64cd4382392a406ce9198cd603b5c50b15`, run [44195702163](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44195702163).
- #233 exact-head CI: `bb901fe9cc4ef67ded575b2b8d34873a4085df1a`, run [44199420503](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44199420503).
- #234 exact-head CI: `9bf7212115e647987769d72466098771ec96eda5`, run [44200928478](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44200928478).
- #235 exact-head CI: `eb519ab020fcd9eb05bf6e74df37b0845ded7603`, run [44201439932](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44201439932).
- #236 exact-head CI: `10659aebd639e8f66dfc327927d8a8e5293471f8`, run [44202004431](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44202004431).

Each listed run passed its three jobs: API/security, tenant Worker integration with ordered disposable D1 migrations and gateway/private Worker integration, and research raster tests. PR #237 is a separate consolidated review surface; its own exact-head CI must be observed before treating the combined candidate as validated.

## Staging validation still required

- [ ] Rehearse the complete migration chain on a disposable clone and compare migration ledgers.
- [ ] Validate source revocation between ingestion lookup and database insert.
- [ ] Race mapping, calibration and policy verify/revoke transitions; confirm losing writes append no event.
- [ ] Race assessment creation against source, mapping, calibration, policy and tenant/site/asset lifecycle changes.
- [ ] Exercise same-key/same-observation assessment requests simultaneously against D1 and confirm one durable row and identical winner responses.
- [ ] Exercise same-key/different-observation requests and confirm conflict without cross-observation disclosure.
- [ ] Verify tenant isolation, reviewer membership/assignment, exact site grants, immutable history and idempotent retries.
- [ ] Independently review the SQL predicates, authorization ordering, migration triggers and failure/recovery behavior.

The current concurrent assessment-insert regression simulates the database conflict result; it is not a true concurrent D1 test. Repository CI is not live staging E2E.

## Release boundary

All constituent PRs and this integration PR remain draft/unmerged. Do not apply migrations, configure secrets, enable ingestion or assessment routes, provision tenants, deploy, or activate production from this document. Release requires independent review, real staging race/replay evidence, exact environment/key reconciliation, migration approval and explicit release authorization.
