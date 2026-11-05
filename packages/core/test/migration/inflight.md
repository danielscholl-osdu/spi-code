# In-flight polling (spicode-t1k.51)

Ports `hasInflight`, `pollInflight` and `progress` from
`keelson-rib-spi@59d6895:src/sweep.ts` into `src/sweep/inflight.ts`, on top of
RUNS2's `pollRun`. `createSweeper` wires them as the Sweeper's `inflight`
option; `Sweeper.hasInflight()` and `Sweeper.pollInflight()` are the host's
entry points. The 15 s timer (`INFLIGHT_POLL_MS`) stays with the host.

A running refresh or upgrade is re-read with `pollRun`; a fork's running
Sync Template is re-read with `readTemplateRuns`. The model recomposes only
when `progress` (status and each job's and step's state, not timestamps) or a
template run's status moved. A run that settles triggers one full sweep.

Moved cases from rib `test/sweep.test.ts`, now in `test/sweep/inflight.test.ts`:

- "recomposes only when the run moved, and sweeps once it settles".
- The template-run half of the dispatch case: a fork's Sync Template goes
  queued, in progress, completed, and the completion sweeps.

Dispatch tracking (`pendingDispatch` and its hold) stays in the rib until M4,
so no rib test is deleted here.

Deltas from the rib:

- Every poll leaves its own `ReadRecord`s, stamped from the injected clock.
  `facts.lifecycle.at` and `facts.runs.at` are not moved by a poll, as in the rib.
- A failed poll keeps the last state beside a failure record whose
  `retainedFrom` comes from the previous poll, else from the run's workflow
  listing (stack) or the fork's `fork-runs` record (templates).
- `cache.lifecycle.lifecycle` follows the polled run, so the next sweep's
  unchanged-listing reuse sees the latest state.
- Polls do not persist; the sweep that follows a settled run does.
- A poll yields to a sweep: it does not start during one, and a sweep that
  starts while a poll is reading discards that poll's results. Concurrent polls
  share one promise. Exec replay and snapshot replay never poll.
- `Sweeper.load` is memoised, so a poll and a sweep that start together
  restore persisted state once.
