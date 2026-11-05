# Upstream-plan inspector

Source: `keelson-rib-spi@59d6895`, `src/boards/upstream.ts`.
`inspectUpstreamPlan` ports the plan board without changing its output. Shared
board types, `inspectRow` and `nextCard` live in `inspect/upstream-shared.ts`
for the subsequent upstream-fork port. Core imports no Keelson board types.
Cards may omit actions, as the fork inspector's "What failed" section does;
the host preserves their fields without producing an action.

The six whole-board SHA-256 oracles in `inspect/upstream-plan.test.ts` were
captured from the pinned rib's `upstreamPlanBoard`, using the same Facts from
`UPSTREAM_STATES`, in declaration order, at `UPSTREAM_NOW`, with the upstream
services fixture and each state's rollout. Hash input is `JSON.stringify(board)`,
including actions and bindings, not a projection, with `TZ=UTC`. The rib pause
and fork-table assertions are ported too; the console action-absence assertions
stay in the rib.

The host accepts only the exact `upstream` id, projects every section into the
existing inspector contract, preserves stored envelopes, binds no provenance,
and disables every action until M4. Model and console code remain unchanged.
