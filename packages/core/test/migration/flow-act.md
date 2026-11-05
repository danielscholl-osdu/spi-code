# Flow action planning (spicode-t1k.37)

Source: keelson-rib-spi `59d6895`, `src/act/flow.ts` and `test/flow.test.ts`.
Requirements: CO-05, PS-04.

Production deltas from the pinned source:

- Replace the Apache header with MIT and change relative import extensions
  from `.ts` to `.js`.
- Wrap `FLEET_RELEASE` in `Object.freeze<Verb>` to satisfy core's static
  context boundary, as in the landed rerun port. The maintainer explicitly
  approved this exception to the pure-move restriction. Its fields and command,
  every function body and existing comment remain unchanged.

No barrel changes, dependencies, execution code or helper rewrites are included.

## Moved planning assertions (8 original cases)

`test/act/flow.test.ts` calls `flowActions` directly rather than inspecting a
Keelson board. The fixtures and explicit context/clock are core's existing ones.
These original case names retain their action-planning assertions:

1. Start rollout dispatches the first wave, carrying main's sha, and the rest wait
2. merges the approved PRs into the free lanes and holds an ordered fork
3. with one lane free the second merge waits and the button says so
4. without an Environment title stops the line: merges pause and the job is linked
5. once a fix lands on main, Retarget dispatches every fork whose PR lacks it
6. with an Environment title on attempt 1 it is re-run once, not a stop
7. offers Fleet Release with publish off, and the Template card counts against main
8. pauses every press that deploys and keeps the re-run for after the hold

The board-only portions of these mixed cases stay in the rib: inspector cards,
status headers, job links, lane/table rendering and Template briefing counts.
Bindings are parsed with the existing schema, not cast.

## Count reconciliation

The brief's "12 moved planning cases" does not match the pinned source split.
Of its 27 original cases, 12 already moved at M1 into `test/flow.test.ts`.
Eight further cases have flow-action assertions, listed above. Seven remaining
cases stay wholly in the rib: the console-card button, inspector lane/table
rendering, three stale-board execution/revalidation cases, last-good pin
rendering, and recorded-facts replay/no-write integration.

Thus 12 M1 + 8 newly split + 7 wholly staying = 27 original cases. Count each
mixed case once as moved for the aggregate ledger, retaining its rib-only
assertions until inspector integration migrates. Do not count duplicate runners
or the four new cases below as additional original migrations.

## New focused coverage (4 cases)

The new file has 12 tests total: eight migrated planning cases and four added
cases for subsequent dispatch, unread/busy starting lanes, explicit blocking
with existing-reason preservation, and retargeting with full lanes. These cover
planner branches without importing boards or executing verbs. The original
rib files and M1 test file are untouched.
