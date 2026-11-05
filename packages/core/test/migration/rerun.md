# Approve and rerun planning (spicode-t1k.28)

Source: keelson-rib-spi `59d6895`, `src/act/approve.ts` and the planning
portion of `src/act/rerun.ts` (through `dispatchActions`, before
`DeployableWait`). Requirements: CO-05, PS-04.

## Production deltas

- Replace the Apache-2.0 headers with SPI Code's MIT headers.
- Change relative import extensions from `.ts` to `.js`; remove the
  Keelson-only `OpHandle`/`RibActionResult` import and the unused
  `attemptText`/`Binding` imports that belong to `DeployableWait`.
- Wrap the four verb objects in `Object.freeze<Verb>` to satisfy core's
  static context boundary. Their fields and commands are unchanged.
- Leave `DeployableWait` entirely in the rib, including its durable-op
  execution, cancellation, progress and stand-down behavior. Core only
  describes the `WAIT_ACTION` offer and retains the original `NO_OPS` reason.
- There are no other non-import deltas. A normalized source comparison
  verifies identical planning bodies after headers, imports and verb freezes
  are removed. `ActionItem`, `Target` and `Verb` already fit without adaptation.
  The existing config, lane, stack, queue, util and rollout helpers are reused.
  No fleet reads, ambient clocks, verb registration or barrel exports are added.

## Moved cases (9)

Two cases from `test/approve.test.ts` run in `test/act/approve.test.ts`:

1. names the author, the diff and the files, and lists one call per run
2. a PR that changes .github/ is approved only after its number is typed

Seven planning cases run in `test/act/rerun.test.ts`: all five
`the environment verbs` cases from `test/inspect.test.ts`, and
`Re-run lanes takes the same cap` plus
`a stop judgement draws no re-run, now or when deployable` from
`test/fleet.test.ts`.

Test adaptations: Bun becomes Vitest; approval inputs use the original PR/run
values directly instead of rebuilding the queue; rerun cases call the planners
instead of the Keelson inspector. Model fixtures use the existing explicit
`fixtureContext` and `FIXTURE_NOW`. Binding casts become `bindingSchema.parse`.
The inspector's missing-scope input becomes the planner's explicit `blocked`
reason. Extra assertions cover exact reasons, absent disabled confirmations,
bindings, full/unread pacing, queued lifecycle runs and stop/block precedence.
No execution behavior is replaced by a planner assertion.

## Staying in the rib

The other seven approval cases remain there: two queue grouping/superseded-head
cases, one inspector/board-validation case, three action-path execution and
revalidation cases, and one approval collector/cache case. At the pinned source,
`bun test test/approve.test.ts` passes all nine cases (34 assertions). The seven
original rerun planning cases also pass there (49 assertions). Nothing in the
source repository is changed or deleted.

`test/act.test.ts`'s `the re-run verbs` and `the re-run wait` suites stay in the
rib: they exercise execution, revalidation, logs, durable ops and rib integration,
not the extracted planning half. The remaining inspector/fleet cases stay too.
For LEDGER, count nine moved original cases, not the temporary copies in both
runners. The other seven approval cases are not claimed as core migrations.

## Added core coverage and parity

Two new core-only cases cover disabled/singular/draft approval presentation and
multiple runs for one PR with differing failed steps. All eleven core cases
appear in `pnpm vitest list`; the full check passes 61 files and 718 tests.

A direct comparison with the pinned rib passes **11,520 lane**, **72 dispatch**
and **192 approval** input combinations, comparing complete `ActionItem` objects
(including enabled/disabled, reason, binding and the entire confirmation) and
target arrays. The matrix covers deployable/no/unknown states, empty/single/
multiple/duplicate-PR lanes, absent steps, stop/retry judgements, absent/null/
zero/full/unread lane caps, busy repos, reserved claims, ops availability,
existing waits, explicit blocks, refresh/upgrade ordering, queued/running
lifecycle runs, draft and association values, file truncation, workflow edits
and single/multiple approvals. Every clock is supplied by the caller.
