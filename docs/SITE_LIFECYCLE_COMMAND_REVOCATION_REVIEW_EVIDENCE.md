# Site lifecycle command authorization revocation — review evidence

**Status:** reviewer handoff only. This document records repository CI evidence; it is not independent security approval, live staging validation, or release authorization.

## Scope

The test sequence extends the durable site lifecycle command HTTP integration after an original administrator loses authorization while a command is pending. It checks that command visibility and mutation rights are re-evaluated against current authorization, while an independently authorized administrator can still resolve an abandoned command with separate attribution.

All integration scenarios use synthetic identities, the signed local Access gateway, the private Worker Service Binding, and disposable local D1. They do not exercise production Access configuration or a live staging environment.

## Exact-head evidence

| PR | Added invariant | Exact head | Exact-head CI |
|---|---|---|---|
| Core #284 | After original administrator membership is revoked, their pending-command apply request is denied; an authorized resolver can still recover and reject the command | `cfa627621e3f0489d0b16355939e453fb1411319` | [44579166350](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44579166350), 3/3 passed |
| Core #285 | After revocation, the former administrator cannot read the individual command or its audit history; resolver visibility remains available | `e9d9338b0c41ef57537aa0be7df125a9ec27e438` | [44579439481](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44579439481), 3/3 passed |
| Core #286 | After revocation, the former administrator cannot use collection-level GET recovery to rediscover the pending command; resolver recovery remains available | `fcdff311447bd0eafb145eafad8f3993629025f7` | [44581157171](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44581157171), 3/3 passed |

Each listed workflow completed successfully on the exact SHA shown. The CI jobs include API/security tests, research raster tests, and tenant Worker tests; the tenant Worker job applies ordered migrations to disposable local D1 and exercises the signed gateway/private Worker integration.

## Follow-up evidence — resolver rejection is also actor-bound

| PR | Added invariant | Exact head | Exact-head CI |
|---|---|---|---|
| Core #289 | After original administrator membership is revoked, their attempt to reject the pending command is denied before the separately authorized resolver acts; the command remains pending for authorized recovery | `da5ee9141e5f175fd20110c638ae9729c1829d7d` | [44584057281](https://github.com/wisemaiarservices-debug/nova-core/actions/runs/44584057281), 3/3 passed |

The #289 regression uses the signed local Access gateway, private Worker and disposable local D1. It complements #284–#286 by covering the rejection mutation route as well as apply, individual read and collection recovery. It does not establish production Access behavior or live staging validation.

## Security properties exercised

- Authorization is checked at the time of apply and read; command authorship does not preserve access after membership revocation.
- Individual command reads and collection-level recovery both deny the revoked actor with not-found behavior.
- The resolver remains separately authorized and receives separately attributed audit history.
- Resolver rejection does not apply a site lifecycle transition, create a lifecycle application, or mutate site status.
- The pending command remains recoverable by an authorized resolver rather than being silently discarded.

## Dependency and review notes

These are test-only branches stacked in order: #284 is based on #282; #285 is based on #284; #286 is based on #285. Preserve the branch ancestry when reviewing or integrating. The PRs remain draft and unmerged.

Independent reviewer actions:

1. Fetch each exact PR head and verify the recorded base/head ancestry.
2. Inspect the membership revocation route, command collection and individual read routes, apply/reject routes, signed gateway actor envelope, and private Worker authorization checks.
3. Independently rerun the exact-head HTTP integration tests against disposable D1.
4. Verify that the database resolver guard rechecks active tenant, active owner/admin membership and exact site read grant at the rejection commit boundary.
5. Verify former-actor denial for apply, individual read and collection recovery, and confirm the resolver's identity is distinct in the append-only audit history.
6. Exercise concurrency and lost-response recovery without weakening actor binding or audit invariants.
7. Record reviewer identity, exact SHAs, commands rerun, findings/severity, remediation SHAs and explicit pass/fail.

## Release boundary

Green repository CI is not an independent security review, live staging E2E, production Access/configuration review, or certification. No independent reviewer sign-off or authorized staging validation is claimed here. Independent security review and explicitly authorized isolated staging E2E remain mandatory before any merge or release decision.

No staging/production migration, deployment, credentials, tenant/site provisioning, customer data, or paid services were used or authorized by this evidence record. Production remains blocked.
