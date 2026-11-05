# Host sweeps

`SweepService` owns one fleet's core collector sweeper. The router supplies a migrated,
file-backed SQLite connection, `CoreContext` (including its clock), the Facts schema,
a `HostExec`, the app-data directory, a doctor getter and an error sink. The service
requires WAL and sets `synchronous=FULL` and a five-second writer-lock timeout on
the same connection it uses for leases, snapshots and pruning. It does not own or
close that connection. No routes or setup gating live here.

`start()` prunes immediately and attempts an immediate sweep, then schedules full
sweeps at `SWEEP_MS`, in-flight polls at `INFLIGHT_POLL_MS`, and pruning daily.
`sweep(force)` coalesces overlapping full-sweep requests and returns false when
another owner holds the fleet. During a poll, it queues a full sweep afterward;
any queued request's force flag applies to that sweep, whose result is returned
even if the poll fails.
`stop()` cancels timers and Exec signals, waits for the sweep to unwind,
then releases only its own fenced lease. Await it before closing the database.
Intentional stop cancellation is not reported to `onError`. Timer generations
prevent a stopped task from rearming after a restart.
Clocks come from the context; `timers.after` is injectable and returns a cancel
function. The default timers are unreferenced and do not keep the host alive.

Each service has a fresh UUID owner. A held lease renews every `ttlMs / 3` (rounded
down); failed renewal aborts its Exec signal and is reported to `onError`.
Exec calls and saves check expiry even if the renewal timer was delayed. Every
snapshot write also checks the fleet, owner, fence and expiry transactionally,
sampling the injected clock after acquiring the SQLite writer lock.
A replacement loads the latest persisted Facts, cache and reads before sweeping,
and the store continues its global cursor.

Snapshot `facts` contains the core `SweepState`. Snapshot `envelope` contains the
validated PROJECT Watch view without its cursor: SQLite allocates the cursor in
the snapshot transaction, so it must not be predicted from another connection's
last write. `latest()` combines the stored view with that authoritative cursor
and validates the complete `ViewSnapshot`.

`sweep-budget.jsonl` under app data receives one line per full sweep, including a
sweep triggered by a settled in-flight poll and failed/cancelled sweeps. Lines
carry `fleet`, the latest `cursor` this holder loaded or committed (zero before either),
`startedAt`, `endedAt`, and core's `cost`, `remaining`, `resetAt`, `deferred` and
`calls` budget record. The cursor comes directly from `writeSnapshot`, not a
readback. A holder-scoped core budget account supplies charges even when a sweep
aborts before core publishes its cached totals; these replace rather than add to
the cached charges. Per-operation charges and deferrals reset before work, including when
restoring a prior cache. A contender, an ordinary poll and an attempt rejected
by the initial lease guard do not log a sweep: no full sweep ran.
Append failures reject the operation rather than hiding missing evidence. If
both the sweep and the append fail, an `AggregateError` carries both errors with
the original sweep failure as its cause.
Daily pruning removes snapshots strictly older than seven days, retaining the
latest snapshot of each fleet so crash recovery always has a resume point.
On the same daily clock, budget-log trimming atomically replaces the file with
records that ended within the last day, including the boundary and all fleets.
Invalid log records fail pruning rather than discarding budget evidence.
Pruning is deliberately unfenced: it is store-wide retention housekeeping, not
a fleet observation or cursor allocation. Its single atomic DELETE preserves
each fleet's latest row and is safe to repeat across services. Running it even
as a lease contender also enforces retention after short-lived host sessions.

`service.test.ts` uses fake timers for cadence, expiry, cancellation and retention.
Its SIGKILL tests launch `holder.mjs` against the built service and kill that real
lease holder both between sweeps and inside the snapshot INSERT transaction,
after insertion but before COMMIT. They prove exclusion before expiry, rollback
of the uncommitted row and cursor, and state/cursor recovery after expiry.
Build the host before running those tests alone.
