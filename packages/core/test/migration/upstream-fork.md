# Upstream-fork inspector

Source: `keelson-rib-spi@59d6895`, `src/boards/upstream.ts` (`upstreamForkBoard`
and its helpers `PHASE_LABEL`, `carriesSection`, `forkTitle`, `forkNext`,
`failedSection` and `lineRows`). `inspectUpstreamFork` ports the fork board
without changing its output and reuses `inspectRow`, `nextCard` and the board
types from `inspect/upstream-shared.ts`. It returns `undefined` for a service
that is not an exact, own key of the model's fork list. Differences from the
rib that do not change output: `PHASE_LABEL` is frozen, the header status is a
copy, and the radar lookup uses `Object.hasOwn`.

The nine whole-board SHA-256 oracles in `inspect/upstream-fork.test.ts` were
captured from the pinned rib's `upstreamForkBoard` for every fork, in fork
order, at `UPSTREAM_NOW`, with `TZ=UTC`. Hash input is `JSON.stringify` of the
array of fork boards, including actions and bindings. Six states are the
`UPSTREAM_STATES`. Three more cover what they do not: `upstream-unread` (no
upstream read, so every fork is unread), `current-and-unread` (partition is
current, unit is done, legal has no radar entry) and `blocked-plus-extra`
(the wave state with a blocked reason and an extra section). The rib has no
fork-board tests of its own; its every-state console test inspects each
`upstream:<service>` id, which the per-state parity covers here.

The host routes exact `upstream:<service>` ids to the fork board, projects it
into the inspector contract (HALT, UNREAD, TOOLCHAIN for an error tone, READY
for an ok tone, ROLLOUT otherwise), preserves stored envelopes, binds no
provenance and disables every action until M4. Any other id answers
`not_found`. Model and console code remain unchanged.
