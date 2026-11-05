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
| act.test.ts | 19 | rib | - | - |
| approve.test.ts | 9 | rib | - | - |
| boards.test.ts | 13 | rib | - | - |
| brief.test.ts | 35 | split | - | - |
| checks.test.ts | 5 | core | 5 | 0 |
| collect.test.ts | 23 | rib | - | - |
| console.test.ts | 22 | rib | - | - |
| engineering.test.ts | 9 | split | - | - |
| fleet.test.ts | 39 | split | - | - |
| flow.test.ts | 27 | split | - | - |
| history.test.ts | 13 | core | 13 | 0 |
| inspect.test.ts | 15 | rib | - | - |
| ledgers.test.ts | 16 | split | - | - |
| marks.test.ts | 3 | rib | - | - |
| model.test.ts | 31 | core | - | - |
| next.test.ts | 6 | split | 5 | 1 |
| radar.test.ts | 14 | split | - | - |
| reason.test.ts | 11 | core | 11 | 0 |
| releases.test.ts | 32 | split | - | - |
| repos.test.ts | 15 | core | - | - |
| repositories.test.ts | 14 | split | - | - |
| rib.test.ts | 19 | rib | - | - |
| rollout.test.ts | 10 | split | - | - |
| security.test.ts | 4 | rib | - | - |
| stack.test.ts | 10 | core | - | - |
| sweep.test.ts | 5 | rib | - | - |
| upstream.test.ts | 45 | split | - | - |
| work.test.ts | 5 | split | 4 | 1 |
| **Baseline total** | **469** | **28 files** | | |
| **Five files ported here** | **40** | | **38** | **2** |

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
