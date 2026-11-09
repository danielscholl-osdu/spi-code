# Host sweeps

`SweepService` owns one fleet's core collector sweeper. The router supplies a migrated,
file-backed SQLite connection, `CoreContext` (including its clock), the Facts schema,
a `HostExec`, the app-data directory, a doctor getter and an error sink. The service
requires WAL and sets `synchronous=FULL` and a five-second writer-lock timeout on
the same connection it uses for leases, snapshots and pruning. It does not own or
close that connection. No routes or setup gating live here.

`start()` prunes snapshots and trims the budget log immediately, attempts an
immediate sweep, then schedules full sweeps at `SWEEP_MS`, in-flight polls at
`INFLIGHT_POLL_MS`, and pruning daily.
Startup budget-log trim errors go to `onError` without blocking the sweep.
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

`progress` holds the latest validated `sweep.progress` whole state in memory.
The twelve sources stay in collector order, with releases last. The core hook
fold drops item-level completeness and carries incomplete read counts only on
cut sources. Every reason code maps to fixed display text; command output is
never copied. Unknown reason codes fail closed to `other`; other invalid reports
are dropped and logged without altering the sweep.
`onProgress` coalesces running updates at 250 ms boundaries. Terminal states
send synchronously, outside the rate cap, and cancel pending running updates
before the next sweep begins. The rate limiter uses timers, not wall-clock differences.
Progress begins only after obtaining the fleet lease; a contender publishes nothing.
First and usual duration come from this fleet's latest persisted snapshot, never
the collector's current, uncommitted facts. Each new sweep has a fresh id.
Only a snapshot commit confirms success. Throws and lease loss report failed;
commit failures use code `save` and name no source. Other failures name a source
only while its state is reading. Intentional stop reports
cancelled. Failed states carry the actual next full-sweep timer's deadline,
or null when stopped, not the GitHub budget reset. Progress is never added to
snapshots, read evidence or budget logs.

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

The projection uses the collectors' thirty-minute cadence for upstream, radar,
security and fleet variables, rather than judging them all against the full-sweep
interval. Cached completed jobs, commit-pinned files and template comparisons
keep their original read times in the read list and persisted state. Their area
and tree envelopes use the latest successful confirmation of the same cache key;
template and detail confirmations also require successful GitHub selectors in
that sweep. Failed, retained and cut records are never refreshed this way.
Due areas deferred by the budget carry a `Read deferred: <reason>` failure record
in the projection, retaining their last good observation rather than claiming
that a read ran. A later successful sweep clears that projection-only failure.

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
At startup and on the same daily clock, budget-log trimming atomically replaces
the file with records that ended within the last day, including the boundary
and all fleets. Invalid log records leave the file intact and report an error
rather than discarding budget evidence.
A malformed, unterminated final fragment is preserved byte-for-byte in
`sweep-budget.jsonl.<sha256>.torn` before removing it from the active log.
The fragment is written, flushed and closed under a unique temporary name before
an exclusive hard link publishes its content-addressed name. Failed writes never
leave a partial quarantine, and temporary files are removed even on failure.
If hard links return `EPERM`, `ENOTSUP` or `EXDEV`, a matching existing quarantine
is reused; otherwise the complete temporary file is atomically renamed into
place. Concurrent same-digest publishers have identical bytes. Byte comparison
makes retries reuse the same quarantine; different bytes already at that path
(including empty or truncated evidence from an older writer) fail visibly
without overwriting evidence. Quarantines are not retention-trimmed.
Successful repair reports its quarantine path through
`onError`. Complete unterminated JSON records instead receive a newline before
the next append.
Quarantines and temporary rewrites are flushed and closed before replacement.
The app-data directory is flushed before repairing (to persist the quarantine
entry) and after each repair or trim rename. Windows directory-flush failures
with `EPERM` or `EISDIR` are unsupported operations and skipped; other failures
remain visible through the existing error path.
Pruning is deliberately unfenced: it is store-wide retention housekeeping, not
a fleet observation or cursor allocation. Its single atomic DELETE preserves
each fleet's latest row and is safe to repeat across services. Running it even
as a lease contender also enforces retention after short-lived host sessions.

`service.test.ts` uses fake timers for cadence, expiry, cancellation and retention.
Its SIGKILL tests launch `holder.mjs` against the built service and kill that real
lease holder both between sweeps and inside the snapshot INSERT transaction,
after insertion but before COMMIT. A competing writer must get SQLITE_BUSY
before the kill, proving the paused holder owns the writer lock. The tests prove
exclusion before expiry, rollback of the uncommitted row and cursor, and
state/cursor recovery after expiry.
Build the host before running those tests alone.
`freshness.test.ts` records and replays five fixture-only collector sweeps,
including unchanged cache keys, thirty-minute reads, budget skips and failure
and completeness guards. It never invokes a forge CLI.
