# Upstream target buttons (spicode-t1k.29)

Source: keelson-rib-spi `59d6895`, `src/act/upstream.ts:1-215` and
`test/upstream.test.ts`. Requirements: CO-05, PS-04.

## Non-import deltas

- Replace the Apache header with the project's MIT header.
- Export `cascadeAction` so UPACT2's neighboring module can call it.
- Wrap the four verb constants in `Object.freeze<Verb>` to satisfy core's static
  context boundary. Their property values and command bodies are unchanged;
  mutation of a shared verb definition is now prevented.
- Leave `UPSTREAM_ITEM`/`UPSTREAM_PREFIX` re-exports and the unused `disabled` and
  `waiting` helpers for UPACT2. Keep `cascadeArgs`, `services`, `laneText` and
  `orderText` here because these builders use them.
- No function body changes. Verbs remain values, with no registration or module
  state. `startAction` retains its existing `load` option although its body does
  not read it. Eligibility gates and disabled reasons belong to UPACT2's callers;
  these builders always produce enabled actions with confirmations.

## Cases moved or split from upstream.test.ts

`test/act/upstream-targets.test.ts` exercises these cases directly at the builder
boundary instead of through UPACT2's `planActions`/`forkActions`:

- "the primary press prepares the pilot and nothing merges"
- "Start merges the sync PR, then dispatches the cascade with its tracking issue"
- "Re-run dispatches the cascade again with the tracking issue" (parameterized
  alongside dispatch, with full confirmation equality)
- "Prepare is not gated on the environment" (builder assertion; caller eligibility
  remains for UPACT2)
- "a cascade press is refused once a newer cascade run exists": only its target
  run-ID binding assertion moves; execution/revalidation assertions stay in the rib.

Additional core cases cover complete Prepare/Start/cascade confirmations, enabled
and reason fields, typed confirmation, lane wording, ordering, schedule wording,
overrides, optional evidence and tracking-issue-free commands. Existing core
`upstream-states.ts` and fixtures are reused unchanged.

## Staying for UPACT2 or in the rib

UPACT2 retains all `planActions`/`forkActions` integration assertions above plus
"a template rollout PR still open keeps Start off the fork", "Review is a link,
never a verb", "a stopped cascade waits for a fix on fork_integration before
Re-run", and "a landed fix does not open Re-run while the environment is held".
Model cases already live in core's `test/upstream.test.ts`. All console,
briefing and inspector assertions, the three "a Start press" execution cases,
`paceTargets` execution pacing and `changed` revalidation stay in the rib.
No rib tests are deleted or represented as a one-for-one test-count migration.

## Parity evidence

A direct comparison against the pinned rib builder bodies and the rib's own
`verbAction`, configuration and formatting helpers returned:

```json
{"source":"keelson-rib-spi@59d6895:src/act/upstream.ts:1-215","states":6,"comparisons":3042,"result":"equal","fields":"complete target and action objects, including disabled, reason and confirm"}
```

This covers all 13 forks in each recorded state, three lane variants, default and
overridden options, and single- and multi-fork cascade confirmations.
