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
  fail only the affected fork. Query failures, missing aliases and search cuts
  preserve last-good state without advancing watermarks. The query
  now requests pageInfo and commit totalCount so nested 50-commit connections
  cannot silently truncate. Truncated PR commits are read fully through
  `Gh.pages` on the REST commits endpoint. These calls use the forge call
  counter; REST requests do not consume GraphQL points. Each search page now
  reserves two GraphQL points (rounding up the search and its 100 nested commit
  connections): four per seeded fork for the initial batch, then two per
  continuation or split-window request. Reported costs still reconcile through
  the shared forge account.
- A failed commit-page read emits PR-specific failure/cut evidence but publishes
  the references already read and permits other PRs and the watermark to advance.
  A zod-validated `pending` map retains unresolved PR facts and counts. Merged
  pending PRs are retried independently of the search window, including after
  serialization/reload, and removed after successful paging. Open PRs are
  retried from the current open search; closed unmerged PRs are discarded.
- Cut connections with no exact total use `read + 1`, explicitly labelled as a
  lower bound. Partial data is not published as a complete ledger.
- Last-good observation times are updated only by complete successful reads;
  repeated failures and search cuts carry `retainedFrom`. A fork whose searches
  were read but whose PR commits remain pending or permanently capped is cut
  at the current time, without `retainedFrom`, because its published facts
  are this read's. Every GitHub GraphQL request goes
  through the existing `Gh` budget account, tested against cost 17.
- `mrRefs`, seed/day handling, GitLab batch size, MR conversion, PR-number
  retention, watermark advancement and URL/body/commit matching are unchanged.

## Council round 1 (historical)

- Known limit: a PR search exceeding 100 results is explicitly cut and does not
  advance that fork's watermark. In particular a merged window with over 100
  PRs can remain stuck indefinitely. Cursor pagination (and GitHub search's
  1,000-result cap/date-window splitting) needs a follow-up bead; it is not
  implemented in this revision.
- Upstream compare exceptions intentionally still omit that fork's partial fact.
  At rib `59d6895`, `out[fork.id] = fact` occurs only after the awaited compare,
  so a thrown compare never publishes its branch-only fact. The core retains
  this publication boundary while emitting project-isolated failure evidence.
  A timeout response, unlike an exception, returns a partial fact with cut
  evidence as previously documented.

## Council round 2

- The only `Gh.pages`/`--jq` call in these collectors now selects
  `.[].commit.message | tojson`. Real gh emits raw strings for the original
  selector, which cannot be parsed as JSON lines and splits multiline messages.
  The fake now mirrors that distinction and includes multiline messages with
  quotes/backslashes; the 51-commit paging case exercises the encoded form.
- REST references are merged before checking the reported total. A short
  response preserves those references in the published fact and pending retry,
  reports the number actually read, and still permits watermark advancement.
- GitHub's 250-commit REST ceiling is a permanent cut when exactly 250 commits
  were returned and the reported total is higher. A zod-validated
  `permanentCuts` map keeps the fact, read count and total separately from
  retryable `pending` entries. Later sweeps (including after reload and while
  the PR is still in the search window) preserve its references and emit
  PR-specific and aggregate cut evidence without another REST request.
  Non-cap shortfalls and transport failures remain retryable.
- The accepted over-100-result search limit was unchanged at that revision;
  its follow-up is implemented below.

## Port-PR search pagination (spicode-cp9)

- Open and merged searches follow `hasNextPage`/`endCursor`, preserving the
  initial per-fork batch. Continuation requests use the same forge budget.
  A synthetic recorded exec log replays 150 merged PRs across two pages,
  publishes all 150, advances the watermark, reproduces the ledger state and
  exhausts the log. The same case covers open PR pagination.
- Merged searches use inclusive UTC date bounds from the seed/watermark day
  through the current clock day. Windows over GitHub's 1,000-result search cap
  split into disjoint day ranges recursively; each resulting window pages
  independently. A 1,200-result case publishes both windows without duplicates.
- A single day still above the cap, or an open search above the cap (which
  cannot be split by merge date), emits a cut and retains the prior ledger,
  observation time and watermark. Missing/repeated cursors and incomplete
  totals also remain explicit cuts; failed continuation reads emit failures.
  No partially read search is published or allowed to advance a watermark.
- Commit paging, retryable `pending` entries, permanent 250-commit cuts, encoded
  multiline messages and PR-number retention keep their existing behavior.
