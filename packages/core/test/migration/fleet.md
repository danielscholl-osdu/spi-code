# Fleet collector migration

Source: `keelson-rib-spi@59d6895`, `src/collect/fleet.ts` and `test/fleet.test.ts`.

The 12 collector cases move to `test/collect/fleet.test.ts`: 14 forks, unresolved
upstream, variables cadence, retained fleet after failure, upstream URL, missing
rollout, rollout lanes/ordering, missing override, retained variables, services
override, GraphQL errors, and local rollout after remote failure. Their collector
assertions run in Vitest; doctor/board/sweeper assertions stay in the rib until
their owning beads migrate them. No source test is deleted here.

Already in core's `test/fleet.test.ts`: rollout schema rejection, noise, model
lane/judgement and dismissal cases. Mirror action eligibility, action pacing,
job annotation reads, boards, inspector and sweeper integration stay in the rib
for their respective action/collector/wiring beads.

## Non-import deltas

- Replace the Apache header with MIT; replace `Bun.YAML.parse` with `yaml.parse`.
- Inline private `repoArgs` into private `blob`; query shape is unchanged.
- Explicit `FleetFiles` defaults to no overrides instead of environment globals.
  The host supplies `context.paths.servicesFile` and `rolloutFile`; those replaced
  the source's `SERVICES_FILE` and `ROLLOUT_FILE` constants in M1.
- `resolveFleet` takes parsed pinned services, not a path. Built-in fallback calls
  `builtInFleet(null)` so it cannot read the environment's services override.
  `fleetView` reads override text through an injected synchronous reader; null
  means missing. Missing rollout is still unpaced; missing services is a failed
  read. File exceptions become failure records instead of escaping.
- `FleetRead` adds current `ReadRecord`s for stack YAML, rollout JSON and each
  repository's variables. `FleetView` carries these plus local-file records.
  Cadence-skipped variables retain their records. Failed reads retain prior
  values and their original successful observation in `retainedFrom`, including
  repeated failures; cold failures do not invent an observation time.
- GraphQL/parse failures return failure records with prior values instead of
  throwing to the rib sweeper. GraphQL errors still reject the whole response;
  per-file parsing failures and per-repository variable failures are independent.
  `readVars` no longer swallows errors: its caller records them and retains values.
  GraphQL accounting remains exclusively in `Gh`'s budget.
- Remove `applied`, `useFleetView` and `activeFleetView`. Callers retain the returned
  view and pass `fleetOf(view.fleet.services)` and `view.rollout.rollout` to
  `createContext`. Context wiring belongs to SWEEP2, not this collector.
- Add fleet-isolation, repeated/cold failure, per-variable evidence, local-file
  retention, new-fork/cadence-boundary and YAML validation coverage. Source tests
  use injected Exec and reader ports instead of RibExec, Store and module setters.

No dependencies added; core already pins yaml 2.9.1. No barrel or shared files
changed. Provenance and regression coverage make this port larger than the plan's
approximate 380-line estimate.
