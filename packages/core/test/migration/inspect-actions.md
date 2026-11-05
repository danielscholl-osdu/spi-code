# Inspector actions and template steps

Source: `keelson-rib-spi@59d6895d140e9482ed788a3307177855d10883f0`,
`src/boards/inspect.ts` and `src/boards/template.ts`.

INSPECT2 ports `verbsOf`, `approvalSection`, `stepTitle`, the step view,
`ladderSection`, `spreadText`, `rolloutActionItems` and `syncNamed`.
The existing core action planners supply every button unchanged.
`createInspectRegistry` creates an isolated registry containing all eleven rib
verbs, including the four registered by `upstreamVerbs`; no module registry
is introduced. No planner was missing and no dependency was added.

## Evidence and migration accounting

`test/inspect/actions.test.ts` compares Next-step actions against each of the ten
unchanged class oracles in `fixtures/rib-59d6895/oracle/inspect/`. Those rib
states offer no execution actions, so populated scenarios are checked too.
The approval-waiting section was absent from the original oracle set.
**New file:** `fixtures/rib-59d6895/oracle/inspect-actions.json`, generated from
the pinned rib, not core. No existing oracle or manifest was regenerated.

Generation extracted `git archive 59d6895` into disposable scratch, linked the
rib's already-installed dependencies, and ran Bun 1.3.13 with UTC and the pinned
services fixture. It imported the pinned `test/harness.ts` (`fixtureFacts`,
`laneFacts`, `FIXTURE_NOW`), `model/index.ts`, `boards/inspect.ts` and
`boards/template.ts`; no forge calls were made. At `2026-10-12T21:58:30Z`, it
froze ten cases (busy/failed lifecycle, missing repo scope, deployable lanes,
no durable ops, deployable wait, existing wait, template actions, approvals,
scope-blocked approvals), both ladder modes, all three fixture steps and a
moved step. The JSON includes each action case's input item, options and fixture
variant. Approval inputs exercise workflow-file, draft and ordinary pills.
The original class oracles retain their original render time.

Moved assembly assertions: the environment-verb cases in rib
`test/inspect.test.ts`, approval card assembly from `test/approve.test.ts`,
ladder/step data from `test/engineering.test.ts`, and sync-action naming from
`test/rollout.test.ts`. Exact action
comparisons include labels, enabled/disabled state, reasons, confirmations and
bindings. Additional cases check no-sweep blocking, sync-name/count boundaries,
lane pacing, empty ladders and isolated registries. All cases are discoverable
under `packages/core/test/inspect/actions.test.ts`.

Board/schema assertions, execution and revalidation, filter-read integration,
dismiss/cleared selections, last-action rendering and durable wait execution
stay in the rib. Lower-level planner tests remain accounted for in
`verbs.md`, approval/rerun coverage in `rerun.md`, `rollout.md`, `upstream-act.md`,
`upstream-act-plan.md` and `flow-act.md`; this bead does not duplicate or delete
those tests. Rib test deletion/wiring belongs to RIBACT.

## Representation changes, not eligibility changes

- Functions return plain data, not Canvas boards: approval/ladder sections drop
  their `kind`, ladder navigation is an `inspect` id, and step status, summary,
  changes, ordered forks and evidence are named fields. Step summary/evidence
  drop board-only glyphs/icons. Host/rib adapters own rendering.
- Time and fleet come from the supplied `CoreContext`; scope, durable-op and
  existing-wait options retain rib semantics. Routine-title patterns are frozen
  to satisfy core's no-mutable-module-collection boundary.
- The rib's 48-character notable-title clipping is retained; the step's changes
  still contain every full title. No changes or forks are silently dropped.
- No app-only M4 policy is applied. Rib reasons and confirmations are unchanged;
  PROJECT owns the host's later-milestone disablement (F12).

## Validation

All 32 inspector-action cases appear in `pnpm vitest list`.
`VITEST_MAX_WORKERS=2 scripts/check` passes both the normal and 400-day-shifted
runs: 84 files, 1,072 passed tests and one pre-existing skip in each run, followed
by successful header and third-party-license checks.
The supplementary oracle's SHA-256 is
`512ec0582b6c0e7add8d2d1e6cc3964f9cc6224983e59125012f33adba75abf3`.
