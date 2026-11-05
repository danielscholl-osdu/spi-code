# Run store (M0)

Import `openRunStore` from `./store.js` and pass a database file path whose parent
directory exists. The store owns the connection; call `close()` before shutdown.
It uses Node 22's `node:sqlite`, WAL and `synchronous=FULL`, with foreign keys
enabled and a five-second writer-lock timeout. Open and write failures propagate.

Migration 1 creates `runs`, append-only `run_events` and a `schema_version` ledger.
Pending migrations and their ledger entries commit together; reopening does not
reapply them. Unknown or non-contiguous schema versions are rejected.

`create` inserts a run; `get` reads it. `appendEvent` returns a per-run sequence
starting at 1. Sequence allocation, insertion and the run's `updatedAt` update
share a `BEGIN IMMEDIATE` transaction. Events cannot be updated or deleted.
Data must be JSON-serializable; invalid data fails before the write.

`listEvents(id, cursor, limit)` reads only sequences greater than the cursor, in
ascending order, with a default page size of 1000. Use the last returned sequence
as the next cursor; `lastSeq` returns the ceiling (0 for no events).
Run lifecycle transitions, intents, approvals and threads are outside this slice.
