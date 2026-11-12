# Store connections and factories

The host calls `openStore(path)` from `./open.js` once, passing a database file
path whose parent directory exists. It returns the migrated `DatabaseSync`;
the host owns it and closes it after its services stop. `createRunStore`,
`createSnapshotStore`, `createLeaseStore` and `createSeenStore` borrow that
connection. Factories do not migrate, close or configure durability: callers
must supply a connection opened by `openStore`.

`openRunStore(path)` from `./store.js` remains the owning convenience wrapper for
other processes, including desktop smoke and crash tests. It combines `openStore`
with `createRunStore` and an idempotent `close()`; borrowed run stores have no
`close()` method. The connection requires Node 22.16 or newer for `node:sqlite`'s
transaction-state check. It
uses WAL and `synchronous=FULL`, with foreign keys enabled and a five-second
writer-lock timeout. Opening fails if WAL cannot be enabled, including for
in-memory databases. Open and write failures propagate.

`createSnapshotStore(db).pruneSnapshots(now)` is the only retention implementation.
It deletes rows strictly older than seven days, retaining each fleet's latest
cursor even if that row is older. SweepService calls it at startup, including
when contending for a lease, and daily on its injected clock. A daily prune failure
reaches `onError` without undoing a previously committed snapshot. Pruning is a
separate statement, outside the snapshot-write transaction.

The shared connection preserves WAL, `synchronous=FULL`, foreign keys and the
five-second writer wait for host writes. Snapshot writes still check the lease
owner, fence and expiry under `BEGIN IMMEDIATE`. A separate desktop lease-release
connection can still use the file concurrently through SQLite's writer locking.
These guarantees retain the existing store's kill durability; they do not protect
against a second host process, manual database changes or failures beyond the M0
store's threat model. A store read error propagates; it never proves an empty
record, successful read or lease ownership.

Migration 1 creates `runs`, append-only `run_events` and a `schema_version` ledger.
Pending migrations and their ledger entries commit together; reopening does not
reapply them. Unknown or non-contiguous schema versions are rejected.

`create` inserts a run; `get` reads it. `appendEvent` returns a per-run sequence
starting at 1. Sequence allocation, insertion and the run's `updatedAt` update
share a `BEGIN IMMEDIATE` transaction. Events cannot be updated or deleted.
Data must be JSON-serializable; invalid data fails before the write.
Error handling rolls back only an active transaction, preserving the original
error when SQLite has already rolled back.

`listEvents(id, cursor, limit)` reads only sequences greater than the cursor, in
ascending order, with a default page size of 1000. Use the last returned sequence
as the next cursor; `lastSeq` returns the ceiling (0 for no events).
Run lifecycle transitions, intents, approvals and threads are outside this slice.

`createLeaseStore` uses an already migrated connection and configures the same
five-second writer-lock timeout itself, including on newly opened connections.
Acquisition and renewal cap that wait at their TTL and restore the connection's
five-second timeout afterward. SQLite waits for transient contention; an exhausted
wait still throws rather than reporting a competing owner. Release keeps the full
five seconds: it runs on quit, and a release that gave up early would leave the
lease held until expiry, blocking the next launch's sweeper for the whole TTL.
The store sets five seconds rather than keeping a timeout the caller chose,
because a fresh connection waits zero and every production caller uses 5000.
The atomic conditional upsert, owner/fence checks and expiry comparisons are
unchanged.

The crash test drives a child through committed appends, kills it with `SIGKILL`
without closing the connection, then reopens the store to verify every committed
event and its contiguous sequence. The child imports the compiled production
store and calls `openRunStore` and `appendEvent`, acknowledging each commit
before proceeding. `scripts/check` builds that output before running Vitest;
run `pnpm run typecheck` before a standalone store test to refresh it.

Migration 3 adds `seen_baselines`, one row per fleet. `createSeenStore` reads it
with `baseline(fleet)` and writes it with `acknowledge(fleet, cursor, items, at)`,
an upsert that only replaces a row when the cursor is newer, so a late or repeated
acknowledgement never moves the baseline back. Items are JSON the caller shapes;
`watch/seen.ts` writes and parses them. `snapshotAt(fleet, cursor)` reads one stored
snapshot for that acknowledgement.

Migration 4 adds `observed_at` to `seen_baselines`: when the acknowledged snapshot's
runs were read, passed as `acknowledge`'s optional fifth argument. A row stored
before it, or one whose snapshot could not tell, reads back `observedAt: null`.
