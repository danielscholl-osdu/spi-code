# Filter collector migration

Source: `keelson-rib-spi@59d6895`, `src/collect/filters.ts` (all 104 lines)
and the on-demand inspector contract at `src/index.ts:589-599`.

The three `filter reads` cases from `test/inspect.test.ts` move to
`packages/core/test/collect/filters.test.ts`: section parsing, cross-fork
absent/listed/unlisted/unread states with GET-only commands, and unsupported
halts making no requests. The inspector board, environment verb, workflow
re-run and other non-filter cases stay in the rib for their owning beads.
No source tests are deleted here. Existing core `model/filter.ts` owns
`filterSection`; this port re-exports it, without duplicating its parser.

## Non-import deltas

- Replace the Apache header with MIT.
- Mark the fixed `CHECKED` lookup and its values readonly to meet core's static
  context boundary; its entries and runtime behavior are unchanged.
- `entryAcrossForks` requires a fourth argument carrying the caller's fleet and
  clock. Iterate `ctx.fleet.forks`, excluding the halted fork, rather than the
  module-level `FORKS`. No default fleet or wall clock is read.
- Add `ForkEntry.reads`: the filter-file and upstream-tree `ReadRecord`s for
  that fork, shared by its entry results. Each read records its own completion
  time from the context clock; failures include `errorText`. The `recorded`
  helper replaces `Promise.allSettled` with the same per-source settled result
  plus evidence. A failed tree still means unread, not absent; a failed filter
  does not hide a successful upstream absence. No state or persistence is added.
- `readTree` takes the tree query object built from the checked halt's path.
  Use the existing `Glab.restAll` to exhaust 100-entry pages rather than silently
  truncating at the rib's first page. Only a fully successful tree is complete;
  a failed later page emits failure evidence and produces unread entries.
  The tree query object is also the evidence object; its source is the project.
- `readFilterFile`, `readFilter`, `checkable`, classification order, verdicts,
  links and result order otherwise retain the source behavior. File-read errors
  still reject directly; `entryAcrossForks` captures them into its read records.
  Calling this collector from the inspector route remains ROUTER's work.
- Tests use Vitest and replayed Exec JSONL instead of Bun and RibExec. Additional
  cases cover file decoding/SHA, checkability, testing-path pagination, later-page
  failure, evidence and interleaved fleets with independent fixed clocks.

No dependencies, barrels or shared configuration changed.
