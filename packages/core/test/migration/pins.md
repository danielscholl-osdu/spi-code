# Pin collector migration

Source: `keelson-rib-spi@59d6895`, `src/collect/ledgers.ts:190-366`.

## Moved tests

- `test/ledgers.test.ts`: "pins come from os-core-common.version and core-lib-azure.version, or the artifact's own version" already moved with RELCOL; its existing core test and implementation remain unchanged.
- "the latest release is the newest semver tag, read at most hourly" moves to `test/collect/pins.test.ts`, including the exact hourly boundary.
- "labels map by upstream project, established wins, the milestone gives the due date" moves to the same file, extended with repeated failures, original retention timestamps and JSON round-trips.
- The library-state and removal-stage model cases already live in core's `test/ledgers.test.ts`. Board/action assertions stay in the rib. No rib tests are deleted here.

## Non-import deltas

- MIT replaces Apache headers. Injected `CoreContext.clock` supplies every timestamp and cadence decision.
- Pin caches are a separate JSON-serializable `PinState`, not the upstream/PR ledger's state. Each collector returns values plus per-source read records; callers own persistence.
- Fork blob cache keys include repository and oid; upstream cache keys include project and head. Unchanged immutable upstream reads reuse their original record, not an invented observation time.
- Fork GraphQL errors are matched by repository alias and field, so unrelated fields remain usable. A missing object, failed blob or total outage emits failed evidence. Failed blobs retry; successful blob parses are reused after each pointer verification.
- Latest tags paginate rather than treating the first 100 as complete. No stable release tag is a failed read, retaining a previously known release if available.
- Latest and removal attempt times enforce the hourly cadence, including after failure. Each retained value keeps its original record's `retainedFrom` or successful `observedAt`; no aggregate cache timestamp becomes retention evidence.
- Removal reads commit atomically after both label queries succeed; a second-query failure cannot publish partially collected labels as fresh.
- Additional recording/replay tests exhaust the fork log and verify GraphQL charges through real `Gh`; tests cover cold outages, oid changes, retries, pagination, independent library failures and recovery.
