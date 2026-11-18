# NOVA Core governed ingestion and assessment V1 — integration candidate

## Candidate

- Consolidated pull request: pending creation from this branch.
- Parent integration base: [#229](https://github.com/wisemaiarservices-debug/nova-core/pull/229).
- Included governed ingestion and assessment changes: [#231](https://github.com/wisemaiarservices-debug/nova-core/pull/231) through [#236](https://github.com/wisemaiarservices-debug/nova-core/pull/236).
- Included HTTP operation-idempotency change: [#238](https://github.com/wisemaiarservices-debug/nova-core/pull/238).
- Runtime source snapshot before this integration note: `1b5266660fd675d6b873d9ebc5d37444c9a2ea58`.

This document describes a draft integration candidate, not a production release.

## Included controls

1. **Ingestion source guard (#231):** a new observation insert is rejected unless its exact source remains verified and matches the tenant, site, module and active-resource scope.
2. **Assessment source lifecycle (#232):** new assessments recheck that the source remains verified and correctly scoped.
3. **Mapping lifecycle (#233):** a mapping cannot be newly verified after its source or mapped resources become ineligible.
4. **Atomic governance transitions (#234):** mapping, calibration and quality-policy review events conditionally append only when the latest state and reviewer authority still permit the transition.
5. **Atomic assessment evidence gate (#235):** passed/failed assessment writes recheck the exact observation and current source, mapping, calibration and policy state at the final insert.
6. **Assessment idempotency (#236):** a request key is bound to its observation; cross-observation reuse conflicts, and same-observation retries return the immutable winner.
7. **HTTP operation idempotency (#238):** the single-use `x-nova-request-id` transport nonce is separate from the stable browser `Idempotency-Key`; each retry uses a fresh transport nonce and the same operation key, which is bound to the tenant and observation.

## Automated validation evidence

- #229 integration head `8063ad968f6af50874b733186385fc7493b2cbfd`, run [44190571076](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44190571076).
- #231 exact-head CI: `360905166e888ce005175b279175b4e28e6747f1`, run [44193036471](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44193036471).
- #232 exact-head CI: `0b6f6e64cd4382392a406ce9198cd603b5c50b15`, run [44195702163](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44195702163).
- #233 exact-head CI: `bb901fe9cc4ef67ded575b2b8d34873a4085df1a`, run [44199420503](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44199420503).
- #234 exact-head CI: `9bf7212115e647987769d72466098771ec96eda5`, run [44200928478](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44200928478).
- #235 exact-head CI: `eb519ab020fcd9eb05bf6e74df37b0845ded7603`, run [44201439932](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44201439932).
- #236 exact-head CI: `10659aebd639e8f66dfc327927d8a8e5293471f8`, run [44202004431](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44202004431).
- #238 exact-head CI: `1b5266660fd675d6b873d9ebc5d37444c9a2ea58`, run [44203727812](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44203727812).
- NOVA OS browser workflow PR #13 exact head `45a70194a98ffdb39821f14b573ef98a93d3e994`, run [44207888914](https://github.com/wisemaiarservices-debug/NovaOS/actions/runs/44207888914), passed tenant resource validation, TypeScript and production build.

The listed Core runs passed their three jobs: API/security, tenant Worker integration with ordered disposable D1 migrations and gateway/private Worker integration, and research raster tests. OS CI validates its repository build and tests. These are repository CI results, not deployed staging E2E or a live cross-repository handshake.

## Browser retry limitation

The OS browser holds the operation key in component memory for retries of the same tenant/observation and clears it after validated success or when the target changes. A full page reload loses the in-memory key; reload-surviving recovery is not implemented. Do not represent this workflow as reload-safe.

## Staging validation still required

- [ ] Rehearse the complete migration chain on a disposable clone and compare migration ledgers.
- [ ] Validate source revocation between ingestion lookup and database insert.
- [ ] Race mapping, calibration and policy verify/revoke transitions; confirm losing writes append no event.
- [ ] Race assessment creation against source, mapping, calibration, policy and tenant/site/asset lifecycle changes.
- [ ] Exercise same-key/same-observation assessment requests simultaneously against D1 and confirm one durable row and identical winner responses.
- [ ] Exercise same-key/different-observation requests and confirm conflict without cross-observation disclosure.
- [ ] Through the real Access gateway, simulate a committed assessment with a lost response; retry with the same operation key and a fresh transport nonce; confirm one durable assessment and the original result.
- [ ] Verify every transport nonce is unique, consumed nonces are rejected, and CORS preflight allows `Idempotency-Key` only for exact configured origins.
- [ ] Verify tenant isolation, reviewer membership/assignment, exact site grants, immutable history and idempotent retries.
- [ ] Independently review the SQL predicates, authorization ordering, migration triggers, key/issuer/audience/JWK reconciliation and failure/recovery behavior.

The current concurrent assessment-insert regression simulates the database conflict result; it is not a true concurrent D1 test. Repository CI is not live staging E2E.

## Release boundary

All constituent PRs and this integration PR remain draft/unmerged. Do not apply migrations, configure secrets, enable ingestion or assessment routes, provision tenants, deploy, or activate production from this document. Release requires independent review, real staging race/replay evidence, exact environment/key reconciliation, migration approval and explicit release authorization.
