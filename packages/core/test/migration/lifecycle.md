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
  failure evidence. Only completely read, completed jobs are cached.
- `LifecycleState` contains attempt-keyed `runJobs`, commit-keyed declaration
  `files`, and the last lifecycle result per workflow. Pass it into
  `readLifecycle` and persist its returned `state`. It is cloned and validated
  on load. Invalid state is discarded with failure evidence.
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
  fully read, timed jobs settle a run's attempt cache. A new attempt cannot
  inherit jobs from a failed read of the previous attempt.
