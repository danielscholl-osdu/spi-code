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
any queued request's force flag applies to that sweep, whose result is returned.
`stop()` cancels timers and Exec signals, waits for the sweep to unwind,
then releases only its own fenced lease. Await it before closing the database.
Clocks come from the context; `timers.after` is injectable and returns a cancel
function. The default timers are unreferenced and do not keep the host alive.

Each service has a fresh UUID owner. A held lease renews every `ttlMs / 3` (rounded
down); failed renewal aborts its Exec signal and is reported to `onError`.
Exec calls and saves check expiry even if the renewal timer was delayed. Every
snapshot write also checks the fleet, owner, fence and expiry transactionally.
A replacement loads the latest persisted Facts, cache and reads before sweeping,
and the store continues its global cursor.

Snapshot `facts` contains the core `SweepState`. Snapshot `envelope` contains the
validated PROJECT Watch view without its cursor: SQLite allocates the cursor in
the snapshot transaction, so it must not be predicted from another connection's
last write. `latest()` combines the stored view with that authoritative cursor
and validates the complete `ViewSnapshot`.

`sweep-budget.jsonl` under app data receives one line per full sweep, including a
sweep triggered by a settled in-flight poll and failed/cancelled sweeps. Lines
carry `fleet`, the holder's last committed `cursor` (zero before the first commit),
`startedAt`, `endedAt`, and core's `cost`, `remaining`, `resetAt`, `deferred` and
`calls` budget record. The cursor comes directly from `writeSnapshot`, not a
readback. Per-operation charges and deferrals reset before work, including when
restoring a prior cache. A contender, an ordinary poll and an attempt rejected
by the initial lease guard do not log a sweep: no full sweep ran.
Append failures reject the operation rather than hiding missing evidence. If
both the sweep and the append fail, an `AggregateError` carries both errors with
the original sweep failure as its cause.
Daily pruning removes snapshots strictly older than seven days, retaining the
latest snapshot of each fleet so crash recovery always has a resume point.
Pruning is deliberately unfenced: it is store-wide retention housekeeping, not
a fleet observation or cursor allocation. Its single atomic DELETE preserves
each fleet's latest row and is safe to repeat across services. Running it even
as a lease contender also enforces retention after short-lived host sessions.

`service.test.ts` uses fake timers for cadence, expiry, cancellation and retention.
Its SIGKILL test launches `holder.mjs` against the built service, kills that real
lease holder after a committed snapshot, and proves exclusion before expiry and
state/cursor recovery after expiry. Build the host before running that test alone.
