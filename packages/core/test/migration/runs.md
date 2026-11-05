# Run and approval collector migration

Source: `keelson-rib-spi@59d6895`, `src/collect/runs.ts:34-174`.

Moved to `test/collect/runs.test.ts`: `approve.test.ts` / "reading waiting runs" /
"matches each run to the open PR at its head and reads its files once per head".
The fixture now supplies all 41 files for PR 327 rather than the rib's truncated
14-file fixture. The six-run matching assertion is unchanged.

Added recording/replay cases cover template conversion and bounded history,
isolated fork failures, interleaved fleets, JSON cache round-trip, head-key cache
misses, pagination, failures at each approval endpoint, cut reads and invalid JSON.

Staying in the rib: all board and action cases in `approve.test.ts` and
`inspect.test.ts`; lifecycle/DetailCache cases in `collect.test.ts` belong to
RUNS2. Neither `collect.test.ts` nor `inspect.test.ts` directly tests these five
functions. No rib test is deleted by this bead.

## Non-import deltas

- Replace the Apache header with the MIT header.
- `toRun` retains its mapping. The run helper returns total-count evidence as
  well as runs. Bounded template/fork histories keep their original 5/10 limits
  and report cut evidence when more runs exist. Approval runs follow pages;
  early empty pages report cut evidence.
- `readTemplateRuns(gh, repo, ctx)` and `readForkRuns(gh, ctx)` return
  `{data, reads}`. Forks come only from `ctx.fleet.forks`; each fork has its own
  record and failure boundary. A failed fork is omitted, not reported empty.
- `readApprovals(gh, ctx, state)` returns `{data, reads, cache}`. Repositories
  come only from `ctx.fleet.repos`. All record times use `ctx.clock`.
  Reads have one record per repository, including empty approval lists.
- The head-keyed cache is cloned/validated through exported
  `prFilesCacheSchema`; invalid loaded state is discarded with a separate
  persistence failure record. The caller's value is never mutated.
- Open PRs and PR files use `Gh.pages`. File count is checked against the PR
  summary, including GitHub's 3000-file ceiling. Incomplete files are neither
  cached nor attached as an approval-ready PR; their record is cut.
- Previously swallowed open-PR/file errors now set the repository's failure
  evidence, preserving unread (`pr` absent), superseded (`pr: null`) and matched
  semantics. Failure reading the run list omits the repository's data.
- Multiple workflow/file cuts are combined into one record's counts and reasons;
  counts describe the cut subreads, not unrelated complete subreads.

Job detail, lifecycle, polling and Keelson Store are outside this module.
