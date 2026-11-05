# Rollout planning (spicode-t1k.27)

Source: keelson-rib-spi `59d6895`, `src/act/rollout.ts` and
`test/rollout.test.ts`. Requirements: CO-05, PS-04.

## Production deltas

- Replace the Apache-2.0 header with the SPI Code MIT header.
- Change relative import extensions from `.ts` to `.js`.
- Wrap the `SYNC_FORKS`, `ROLL_OUT` and `PLURAL_VERB` constant objects in
  `Object.freeze` to satisfy core's static context boundary (no mutable module
  collections). The verbs use `Object.freeze<Verb>` for contextual typing.
- Require the caller's `forks: readonly ForkDef[]` in
  `syncTargets(t, forks, load?)`, `rolloutTargets(t, forks, load?)` and
  `rolloutActions(t, binding, now, forks, blocked?, load?)`. Thread it through
  `mirrored(repo, forks)` to `forkOf(repo, forks)`, rather than consulting the
  built-in fleet. This preserves CO-02 and the rib's mirror/unread behavior for
  the fleet actually being inspected; no default silently selects another fleet.
- Export the planners from `act/index.ts`. Export this area's `heldText` as
  `rolloutHeldText` there to avoid clashing with the existing stack helper in
  core's root barrel. `heldBecause` re-exports the same template declaration.
- No other deltas: verb field values, eligibility predicates, disabled reasons
  and confirmation text are unchanged. The existing
  VERBS module re-exports core's `ActionItem`, so no type adaptation is needed.
- No registration side effect is added. INSPECT2 owns wiring the verb values.

## Moved cases (5)

These cases from `test/rollout.test.ts` now also run in
`packages/core/test/act/rollout.test.ts`, with their original names:

1. Sync all forks / dispatches every fork behind main whose PR does not carry it
2. Sync all forks / skips a fork already syncing and one whose PR is at main
3. Roll out / nothing is ready while every PR needs review and is red on the stack
4. Roll out / merges the approved green PRs and names each one held back and why
5. Roll out / a draft and running checks hold a PR too

Test adaptations: Bun becomes Vitest; imports use core's existing fixture helpers
and explicit five-fork `fixtureContext`; unsafe target assertions become guards;
`toStartWith` becomes `toMatch`. The draft case additionally checks pending checks;
the merge case validates the binding; disabled actions have no confirmation.

## Staying in the rib (5)

These are not core rollout-planning cases and remain unchanged in the rib:

1. the rollout inspector's buttons / Sync all forks names up to three forks, then counts
2. the rollout inspector's buttons / the rollout leads with Start rollout and says why the merge waits
3. the rollout inspector's buttons / a dispatch carries the osdu-spi main it was drawn for
4. the rollout inspector's buttons / Merge binds the approved, green PRs at main to the rollout item
5. a dispatch through the action path / runs on idle forks and skips one that started syncing since the draw

The first four exercise `boards/template.ts` and `boards/inspect.ts`, including
Keelson board validation; INSPECT2 owns their action assembly. The last exercises
the rib's execution, revalidation and action log. This bead removes no rib tests.
The original suite at the pinned revision passes all 10 cases (43 assertions).
For the migration total, count five moved cases and five staying cases, not the
temporary copies in both runners.

## Additional core coverage and parity

Five new core-only cases cover distinct-repo pacing and cascade reservations,
uncapped/full/unread lane loads, dispatch and busy exclusions, held and pacing
text, explicit blocking, empty/current/unread fleets, exact command bindings and
typed merge confirmation counts. A council regression additionally supplies
`mirror: true` and `mirror: null` forks, checks both buttons' skipped/held reasons,
disabled states and absent confirmations, then interleaves an ordinary fleet
whose buttons remain enabled with the correct confirmations and bindings.
All 11 core cases appear in `pnpm vitest list`.

A direct comparison against the pinned rib passed 960 combinations: three caller
fleets, 16 template states, 10 lane loads and two explicit-blocking states.
The fleets are the recorded fleet, one with legal as a mirror and schema's mode
unread, and one with explicit non-mirror modes. The rib's `setFleet` receives
each fleet while core receives it as an argument; the rib's original fleet is
restored afterwards. It compares complete
`syncTargets`, `rolloutTargets`, `heldText`, `paceText`, `waitSuffix` and
`rolloutActions` outputs, including disabled, reason and the entire confirmation.
Template states include red and ready fixtures, no head, no rows, no PRs, no next
sync/steps, draft/pending/red/review/conflict/behind holds, a PR carrying main, and
running/dispatched syncs. Lane loads include uncapped, zero/one/two seats, in-flight
work, unread checks and reserved cascade claims. The initial port matched the
source after header/import normalization; the complete deltas now also include
the constant freezes, required fleet arguments and barrel exports listed above.
