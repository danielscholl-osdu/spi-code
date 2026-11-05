# Upstream and ledger collectors

Source: `keelson-rib-spi@59d6895`, `src/collect/upstream.ts` (all),
`src/collect/ledgers.ts:13-189`. MIT relicensing follows `AGENTS.md`.

## Moved cases

`test/ledgers.test.ts`:

- “a fork PR cites an upstream MR by its GitLab URL, in the body or a commit message”
  moves to `test/collect/ledgers.test.ts`, with duplicate-reference coverage.
- “merged fork PRs are kept by number and later reads ask only since the newest merge”
  moves to the same file, including the failed-read fallback.
- “a failed merged-MR read keeps the last good list; a paged-out project stays unread”
  moves to the same file.

The other ledger model cases already live in core's `test/ledgers.test.ts`.
The inspector assertion and boards remain in the rib. Pin, latest and removal
collector cases stay for RELCOL/PINS. No original case was deleted.

`test/upstream.test.ts` has no `readUpstream` collector cases: its model cases
already moved to core; boards and action execution remain in the rib.
New `test/collect/upstream.test.ts` replays glab branch/compare responses derived
from the existing upstream Facts fixture, checks exact commit equality and
cache reuse, and covers isolated project failure, compare timeout and no-compare
paths. Ledger additions cover partial aliases, commit/search cuts, forge budget
accounting, state validation, retained timestamps and caller fleet isolation.
All clocks are fixed.

## Non-import deltas

- Both collectors require `CoreContext`; fork lists come from `ctx.fleet` and
  evidence times from `ctx.clock`. Empty seeded fleets do not send GraphQL.
- `readUpstream` returns `{upstream, reads}`. Each project catches its own error
  and emits a failure record instead of rejecting the whole pool. Branch and
  compare reads have separate records. A timed-out compare emits a cut record,
  does not measure lag, and is not cached; missing commits fail explicitly.
  Complete fixed-SHA compares retain the original in-memory cache behavior.
- `LedgerState` contains only merged MRs, port PRs and last-good observation
  times. Pin, latest and removal fields are outside this bead. State remains a
  plain caller-owned value; `loadLedgerState` validates deserialized values with
  zod and discards invalid state with a failure record. No Store or file I/O.
- `readMerged` returns `{merged, reads}`. Missing projects and failed batches
  have individual failure records. Paged-out connections have cut records.
  Failed/cut reads preserve prior lists and their original observation times,
  rather than dropping a previously read list on a cut response.
- `readPortPrs` adds `reads` to its original result. Alias-scoped GraphQL errors
  fail only the affected fork. Query failures, missing aliases, search cuts and
  commit cuts preserve last-good state without advancing watermarks. The query
  now requests pageInfo and commit totalCount so nested 50-commit connections
  cannot silently truncate. Complete PR matching and counters are unchanged.
- Cut connections with no exact total use `read + 1`, explicitly labelled as a
  lower bound. Partial data is not published as a complete ledger.
- Last-good observation times are updated only by complete successful reads;
  repeated failures/cuts carry `retainedFrom`. Every GitHub GraphQL request goes
  through the existing `Gh` budget account, tested against cost 17.
- `mrRefs`, seed/day handling, GitLab batch size, MR conversion, PR-number
  retention, watermark advancement and URL/body/commit matching are unchanged.
