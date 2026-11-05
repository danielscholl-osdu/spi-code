# Upstream action planning (spicode-t1k.36)

Source: keelson-rib-spi `59d6895`, `src/act/upstream.ts:216-429` and
`test/upstream.test.ts`. Requirements: CO-05, PS-04.

## Non-import deltas

- Replace the Apache header with the project's MIT header.
- Keep `UpstreamActions`, `blockAll`, `planActions` and `forkActions` unchanged.
  Bring over the small `services`, `disabled` and `waiting` helpers they use.
  Builders and immutable verb values come from the landed `upstream-targets`.
- Change `upstreamVerbs(): Verb[]` to `upstreamVerbs(registry: VerbRegistry): void`:
  register the same four verbs in the caller's registry, without module state.
  Registry duplicate-registration errors propagate unchanged.
- Re-export both upstream modules through the act barrel, including the
  upstream item keys. No execution, approvals or host-wide write policy moves.

## Cases moved or split from upstream.test.ts

`test/act/upstream.test.ts` ports the planning assertions:

- "the primary press prepares the pilot and nothing merges"
- "a template rollout PR still open keeps Start off the fork"
- "Start merges the sync PR, then dispatches the cascade with its tracking issue"
- "Review is a link, never a verb"
- "a stopped cascade waits for a fix on fork_integration before Re-run"
- "Re-run dispatches the cascade again with the tracking issue"
- "a landed fix does not open Re-run while the environment is held"
- "Prepare is not gated on the environment", through `forkActions`

Additional cases check global write blocking (including preservation of existing
waits), registry isolation, and pacing: Start and both cascade verbs are paced;
Prepare is not. Rename UPACT1's builder-level environment case to "Prepare keeps
schedule wording and the label override"; its assertions are unchanged.

## Staying in core or the rib

Model assertions already live in core's `test/upstream.test.ts`. UPACT1's direct
target/builder tests remain in `test/act/upstream-targets.test.ts`; they cover the
builder boundary, not the planning eligibility checked here.

All console, briefing and inspector rendering assertions stay in the rib,
including the plan-board pause and every-state board validation. The three
"a Start press" execution cases, `paceTargets`, and `changed` revalidation also
stay there. No rib tests are deleted or claimed as a one-for-one count migration.

## Parity evidence

An independent probe evaluates the pinned rib's upstream module with core's
ported configuration, model and verb-formatting dependencies, then compares it
with the compiled core planners. It covers the six recorded states, each state's
lane load plus unpaced, full, unread and available lanes, global blocking, every
fork, and per-fork verb/wait variants. Complete action objects compare equal:

```json
{"source":"keelson-rib-spi@59d6895:src/act/upstream.ts","states":6,"comparisons":8640,"result":"equal","fields":"complete plan and fork action sets, including labels, bindings, disabled reasons and confirmations"}
```

All ten new cases and the renamed builder case appear in `pnpm vitest list`.
