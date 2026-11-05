# Verbs (spicode-t1k.11)

Source: keelson-rib-spi `59d6895`, `src/act/verbs.ts` and `test/act.test.ts`.
CO-03, CO-05, PS-04. Core owns the planning ActionItem shape; no CanvasBoardView
or Keelson import remains. Schemas and button eligibility are unchanged.
`createRegistry()` replaces the module registry with an independent value exposing
`registerVerb` and `verbOf`; unregistering is idempotent.

## Moved cases from act.test.ts (2)

| Rib case | Core case |
|---|---|
| the button / carries the binding apart from its payload and confirms with the exact commands | `test/act/verbs.test.ts`, same name; Keelson `expectView` assertion stays in the rib, strict core binding validation is checked here |
| the button / a verb that cannot run renders disabled with its reason and no confirmation | `test/act/verbs.test.ts`, same name |

## Staying in the rib

All other `act.test.ts` cases stay: the action path (writes, revalidation,
binding dispatch), action log and its inspector rendering, readiness (scope
probe, projects, doctor), re-run execution and DeployableWait including rib
integration. These require execution, persistence or Keelson and are not VERBS
planning cases. No rib files or tests are removed by this bead.

Additional core-only cases cover strict binding/target rejection, registry
isolation and disposal, shell quoting and follow-up command text, button
overrides and typed confirmation, and sweep/scope write eligibility.
The host's later-milestone disablement belongs to PROJECT, not core (D9/F12).
