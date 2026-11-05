# Lifecycle and job detail collector migration

Source: `keelson-rib-spi@59d6895`, `src/collect/runs.ts:175-398`.

Moved to `test/collect/lifecycle.test.ts`:

- `collect.test.ts` / "lifecycle jobs" / "a re-run that clears maintenance is
  read again, not served from the first attempt".
- The four `fleet.test.ts` "failure class from the annotation title" cases that
  call `readJob`: failure-level Environment, untitled failure, notice-level
  Environment, and Environment on attempt 2. They still assert `judgeRun`.

Staying in the rib: the remaining pure judgement and queue-framing cases in
`fleet.test.ts`, and all scheduling/dispatch cases in `sweep.test.ts`. In-flight
scheduling belongs to SWEEP3, not this collector. No rib test is deleted here.

Added recording/replay cases cover JSON cache loading, corruption evidence,
size-cut raw logs, failed logs retaining an annotation reason, job pagination,
short pages, immutable declaration reads, repeated failure retention, and
per-poll clock observations. All tests are in the core Vitest project.

## API and non-import deltas

- Replace the Apache header with the MIT header. `RawRun` and `toRun` are exported
  from the landed runs collector so the existing mapping is reused unchanged.
- `DetailCache` is a plain `repo#job` record of `{data, reads}`. Pass it into
  `readJob`, `readRunJobs`, `readLifecycle` or `pollRun`; retain the returned
  `cache`. Load validation drops bad entries individually with persistence
  failure evidence. Completed jobs are cached when reads succeeded; a deliberate
  job-log character cut is final and stays in the cached evidence.
- `LifecycleState` contains attempt-keyed `runJobs`, commit-keyed declaration
  `files`, and the last lifecycle result per workflow. Pass it into
  `readLifecycle` and persist its returned `state`. It is cloned and validated
  on load. Undefined/null state starts empty; malformed state is discarded with
  failure evidence.
- Collector results contain `{data, reads, cache}`; `readLifecycle` also returns
  `state`. `pollRun` takes a previous `{data, reads}` and the injected
  `CoreContext`, so a failed poll retains both the run and its original
  observation time. There is no timer, filesystem I/O, or module-level state.
- Every gh read runs over Gh/Exec and produces evidence. Cached data keeps its
  actual old read times. Failed workflow/job reads retain prior data with
  `retainedFrom`; failures never become empty successful reads. Partial
  annotation/log failures remain visible and are retried.
- Job lists use the attempt-specific REST endpoint and paginate with counts;
  annotations use `Gh.pages`. Job/run pagination deduplicates IDs and stops at
  100 pages or a non-progressing page with cut evidence. Response order is kept.
  Evidence is assembled in input order despite concurrent requests.
- The last 64,000 characters of a job log are inspected. A larger log produces
  a cut record with actual/read character counts, never complete evidence.
  Test fakes emit log text raw, matching real gh output.
- Active run jobs are also kept for failure retention, but only completed,
  timed jobs fetched against the same completed run status and updatedAt settle
  a run's attempt cache. Legacy snapshots without that metadata are refreshed.
  Other cuts and failures prevent settlement; a deliberate job-log character
  cut does not. A new attempt cannot inherit jobs from a failed read of the
  previous attempt.

## Council fixes against the pinned rib

All five findings are port regressions, not inherited bugs:

1. The rib saves `runJobs` only when the run is completed. This port also keeps
   active snapshots for retention, so it now records the run status/updatedAt
   associated with a successful jobs snapshot before allowing it to settle.
   Regression: "active snapshot with %i jobs is fetched again after completion"
   covers empty and non-empty active lists.
2. The rib carries a target across polls but has no ReadRecord envelope. Losing
   its declaration evidence was introduced here. Successful polls now retain
   only the declaration records supporting that target, without carrying old
   run/job/workflow records. Regression: "successful polls retain target
   declaration evidence but not superseded run and job reads".
3. The rib caches completed job details and has no log character cap. Treating
   a final size cut as a reason to fetch the full log forever was introduced
   here. Regression: "completed runs settle with cached size-cut log evidence
   while other cuts and failures retry"; the Java Build case also verifies JSON
   round-trip with the cut record intact.
4. The rib calls `cache.put(repo, kept)` on a job cache hit. Restore that write
   here. Regression: "readJob sees refreshed steps written back by a run-jobs
   cache hit". Its follow-up provenance check uses the current listing to
   support refreshed fields and retains only the original annotation/log reads
   for reused explanations. Repeated refreshes replace older job/list reads.
5. The rib takes an initialized state and has no persistence-validation failure
   for cold starts. Regression: "cold lifecycle state %s starts empty without a
   persistence failure" covers undefined/null and still checks malformed state.
