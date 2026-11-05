# Run store (M0)

Import `openRunStore` from `./store.js` and pass a database file path whose parent
directory exists. The store owns the connection; call `close()` before shutdown.
It requires Node 22.16 or newer for `node:sqlite`'s transaction-state check. It
uses WAL and `synchronous=FULL`, with foreign keys enabled and a five-second
writer-lock timeout. Opening fails if WAL cannot be enabled, including for
in-memory databases. Open and write failures propagate.

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

The crash test drives a child through committed appends, kills it with `SIGKILL`
without closing the connection, then reopens the store to verify every committed
event and its contiguous sequence. The child mirrors the store's append
transaction using `node:sqlite` and acknowledges each commit before proceeding.
