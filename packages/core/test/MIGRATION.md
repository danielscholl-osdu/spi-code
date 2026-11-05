# Rib test migration

CO-04 baseline: keelson-rib-spi `59d6895d140e9482ed788a3307177855d10883f0`,
Bun 1.3.13. Counts come from `fixtures/rib-59d6895/test-count.json`: 28 files,
469 tests, 2,219 assertions, no failures or skips.

The destination is the M1 plan, not a claim that every file has moved. `core`
means the whole file moves; `rib` stays with collectors, actions or boards;
`split` keeps those tests in the rib and moves pure domain tests. A dash means
the split has not yet been implemented or counted. Moved and staying counts
refer to the pinned tests, not new harness checks or duplicate tests that the
rib still runs before switching to core.

| Rib file (`test/`) | Rib tests | Destination | Moved to core | Staying in rib |
|---|---:|---|---:|---:|
| act.test.ts | 19 | rib | 0 | 19 |
| approve.test.ts | 9 | rib | 0 | 9 |
| boards.test.ts | 13 | rib | 0 | 13 |
| brief.test.ts | 35 | split | 35 | 0 |
| checks.test.ts | 5 | core | 5 | 0 |
| collect.test.ts | 23 | rib | 0 | 23 |
| console.test.ts | 22 | rib | 0 | 22 |
| engineering.test.ts | 9 | split | 3 | 6 |
| fleet.test.ts | 39 | split | 12 | 27 |
| flow.test.ts | 27 | split | 12 | 15 |
| history.test.ts | 13 | core | 13 | 0 |
| inspect.test.ts | 15 | rib | 0 | 15 |
| ledgers.test.ts | 16 | split | 9 | 7 |
| marks.test.ts | 3 | rib | 0 | 3 |
| model.test.ts | 31 | core | 31 | 0 |
| next.test.ts | 6 | split | 5 | 1 |
| radar.test.ts | 14 | split | 13 | 1 |
| reason.test.ts | 11 | core | 11 | 0 |
| releases.test.ts | 32 | split | 10 | 22 |
| repos.test.ts | 15 | core | 15 | 0 |
| repositories.test.ts | 14 | split | 6 | 8 |
| rib.test.ts | 19 | rib | 0 | 19 |
| rollout.test.ts | 10 | split | 0 | 10 |
| security.test.ts | 4 | rib | 0 | 4 |
| stack.test.ts | 10 | core | 10 | 0 |
| sweep.test.ts | 5 | rib | 0 | 5 |
| upstream.test.ts | 45 | split | 18 | 27 |
| work.test.ts | 5 | split | 4 | 1 |
| **Baseline total** | **469** | **28 files** | **212** | **257** |
| **First port: spicode-2u4.3** | **40** | **5 files** | **38** | **2** |
| **Model ports: spicode-2u4.9** | **125** | **6 files** | **87** | **38** |
| **Briefing and release: spicode-2u4.4** | **172** | **7 files** | **87** | **85** |
| **Rib-only files** | **132** | **10 files** | **0** | **132** |

The complete ledger reconciles: 40 + 125 + 172 + 132 = 469 baseline tests;
38 + 87 + 87 = 212 moved, and 2 + 38 + 85 + 132 = 257 staying.
Every file has been counted, and 212 + 257 = 469.

## First port: spicode-2u4.3

The core ports use the same relative module layout as the rib. Their bodies and
assertions stay unchanged except for Vitest runner compatibility: Bun's
`toStartWith` and `toEndWith` in `reason.test.ts` become equivalent anchored
`toMatch` assertions. These five files contain no `Bun.sleep` calls. MIT headers
and repository formatting are applied.

Two mixed tests are deliberately not ported:

- `work.test.ts`: "a repository read reports authors' association, app authors and
  open totals" tests `collect/github.parseRepo` and stays in the rib.
- `next.test.ts`: "the inspector reads the forks that list a halted entry into
  its Next line" tests `boards/inspect.inspectBoard` and stays in the rib.

The rib source is read-only in this bead. Its eventual switch must retain these
two tests and remove only the 38 tests ported here from its runner.

`harness.ts` contains the pure `fixtureFacts`, `releasedFacts`, `laneFacts`,
`FIXTURE_NOW` and `NEW_HEAD` pieces of the pinned rib harness. It reads the
recorded baseline fixture, clones Facts per call, and has no Keelson imports,
temporary-home creation or environment mutation. Board helpers, fake snapshots,
exec and context helpers stay in the rib. No `states.ts` helper is needed by
these five ports.

## Running and typechecking

Run `pnpm exec vitest run --project packages/core` from the repository root.
The history tests inherit Bun's UTC default through a local runner setup module;
their explicit Chicago checks still switch zones and restore UTC.

`packages/core/tsconfig.json` is a composite solution project referencing the
unchanged library build settings in `tsconfig.build.json` (`rootDir: src`,
`outDir: dist`) and the no-emit `test/tsconfig.json`. Root `tsc -b`, including
`scripts/check`, traverses both. The test project references the library build
and uses Bundler resolution for the preserved extensionless test imports. Test
JavaScript and declarations are never emitted into `dist`.

Per-file source diffs, count verification and the five inverted-assertion
failures are recorded on bead `spicode-2u4.3`.

## Model ports: spicode-2u4.9

These six pinned files contain 125 tests: 87 move here and 38 stay in the rib.
Their table rows count original cases, not extracted assertions.

`model.test.ts`, `stack.test.ts` and `repos.test.ts` move in full. The model's
rollout and environment-recovery assertions remain intact. `model-fleet.ts`
loads the recorded five-fork fleet for model, radar and repos, then restores
the built-in fleet. Stack uses the existing UTC runner shim so its daily
history assertion retains Bun's timezone semantics.

Radar's "names a queued halt and a queued Java move before the sync runs"
stays in the rib: the same case validates inspector boards. Its model
assertions are not deleted or rewritten.

Upstream moves 18 model-only cases, preserving their original groups, setup,
bodies and assertions. The remaining 27 cases exercise actions, boards or
briefing built through the rib's doctor status. They stay in the rib intact,
including mixed model/action cases. `upstream-states.ts` and its two recorded
fixtures are copied from `59d6895`; the helper's import paths remain relative.
Upstream restores the fleet and active rollout in its original cleanup hook.

At `59d6895`, all ten `rollout.test.ts` cases target `act/rollout`, inspector
buttons or the action path. There are no model-only or rollout-brief cases in
that file, so it moves zero tests. The core rollout cases in `model.test.ts`
move with that file; the other builder's briefing file is not changed here.

Runner imports, MIT headers and repository formatting are the only other
changes. Bun's two `toStartWith` assertions become equivalent
`startsWith(...).toBe(true)` assertions. Per-file source comparison evidence
and five inverted-assertion failures are recorded on `spicode-2u4.9`.

## Briefing and release port: spicode-2u4.4

The seven assigned files move 87 pinned cases and leave 85 in the rib. Every
assigned row adds up to its count in `test-count.json`. The ten `rib` rows
record 0 moved and all 132 cases staying. The six rows owned by spicode-2u4.9
are also counted: the complete ledger reconciles all 469 baseline cases,
with 212 moved to core and 257 staying in the rib.

Mixed cases stay whole in the rib, including cases that assert model output
and then inspect a board. Releases moves the two body parsers, six month-facts
cases and two document-model cases; collector, notes I/O, PDF, board and agent
cases stay. The rollout brief in `rollout.test.ts` belongs to spicode-2u4.9.

Bodies and assertions are unchanged except for equivalent anchored `toMatch`
checks replacing Bun's `toStartWith` and `toEndWith`. Imports use Vitest and
core's extracted release and notes types. No ported case needs `Bun.sleep`.
The existing recorded release and rollout JSON fixtures are structurally
identical to the pinned rib fixtures and are reused at their baseline paths.

`briefing-setup.ts` reproduces Bun's UTC default and `test/preload.ts`'s
five-fork fixture fleet, restoring the prior fleet after each file. Briefing
tests supply the recorded clear doctor input rather than importing a board:
the recorded sweep has successful auth probes, no read errors and 4,889
GraphQL points remaining. Explicit dark, partial and waiting inputs remain.
`flow-states.ts` ports the pure pinned `test/states.ts`; `release-fixtures.ts`
ports its notes `skeleton` input helper. The shared `harness.ts` is unchanged.

Per-file source comparisons, moved/staying counts and five inverted-assertion
failures are recorded on the bead. Core source and runner configuration are
unchanged.

## Context threading: spicode-2u4.5

Core accepts an immutable `CoreContext`: its fleet lists, environment-read
paths (facts, services, rollout and lane override), rollout policy and clock.
Use `fleetOf(services)` and `createContext({ fleet, paths, rollout, clock })`,
or `contextFromEnv(env, clock)` to snapshot environment inputs and load the
configured services file. The host supplies the parsed active rollout; core
does not read or watch its file. `environment.ts` is the only ambient
environment reader and `clock.ts` is the only ambient clock adapter.

`buildModel(facts, now, opts, context)`, `buildBriefing(model, doctor, now,
context)` and `readItem(model, item, now, context)` keep explicit `now`
compatible; pass `undefined` for it to use the context clock. `cadence`
accepts context after `now` too. Fleet-sensitive `predictAll`, `buildRepos`,
`buildWork`, `laneCap`, `laneLoad`, `buildQueue`, `buildRollout`, `componentId`
and `monthFacts` accept trailing context. `forkOf` accepts the explicit fork
list. Omitted context uses the frozen default snapshot. The old fleet
constant exports are immutable compatibility views of that default, not
live sweep state. `setFleet` and `useRollout` are removed: make a new context
instead. `replayFile(context)` reads its facts path.

Only signature-forced setup and argument changes were made to the ported
tests; no assertion was removed or changed:

- `briefing-setup.ts` and `model-fleet.ts`: export the recorded five-fork
  context instead of installing and restoring module-global fleet state.
- `brief.test.ts`, `engineering.test.ts`, `ledgers.test.ts`,
  `repositories.test.ts`, `model.test.ts`, `radar.test.ts`, `repos.test.ts`:
  pass that fixture context to each `buildModel` call.
- `releases.test.ts`: pass fixture context to `monthFacts` and read its fork
  list instead of the former live fleet export.
- `fleet.test.ts` and `flow.test.ts`: use a local context per case, reset it
  in the existing cleanup hook, and replace rollout setters with new
  contexts. Every model call receives that context.
- `upstream.test.ts`: construct the upstream fixture fleet once, then pass
  a fresh context carrying each Facts input's rollout into `buildModel`.

`context.test.ts` adds interleaved fleet/policy/path isolation and fixed-clock
proofs for briefing, model, reading and cadence under a third ambient clock.
`context-boundary.test.ts` parses every source file except the two adapters
and rejects module-global variables, unsafe collections and collection
writes, exported setters, environment reads and ambient clock calls.
Its planted cases exercise each rule; the physical planted-source failure
and subsequent clean run are recorded on the bead. Existing 212 migrated
baseline cases remain intact; the new acceptance cases are not part of the
469-case migration ledger.
