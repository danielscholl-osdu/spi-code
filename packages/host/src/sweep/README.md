# Host sweeps

`SweepService` owns one fleet's sweeper: the schedule, the fenced lease, the
snapshot writes and retention. It borrows the host's SQLite connection and does not
close it; await `stop()` before closing the database. No routes or setup gating
live here.

- Only a snapshot commit confirms a sweep succeeded.
- Progress lives in memory. It is never added to snapshots, read evidence or the
  budget log.
- `sweep-budget.jsonl` under app data gets one line per full sweep. An append
  failure rejects the operation rather than hiding missing evidence, and a torn
  final fragment is quarantined, never dropped.

The SIGKILL tests in `service.test.ts` launch `holder.mjs` against the built
service: build the host before running them alone.
