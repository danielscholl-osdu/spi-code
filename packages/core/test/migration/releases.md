# Release collector migration

Source: `keelson-rib-spi@59d6895`.

## Moved tests

- `test/releases.test.ts`: "a pin read with GraphQL errors is recorded and retried, never cached" and "poms: Java from the first property set, test modules never pin the library" move to `test/collect/releases.test.ts`, using real Gh over recording/replay Exec rather than a cast fake.
- `test/ledgers.test.ts`: "pins come from os-core-common.version and core-lib-azure.version, or the artifact's own version" moves to `test/collect/pins.test.ts`.
- Release body/model tests already live in core's `test/releases.test.ts`; notes, board, PDF, file-watching and action tests stay in the rib. No rib tests are deleted here.

## Non-import deltas

- MIT replaces Apache headers. `ReleaseFact`, `BuildPins`, `ReleaseReads` and `pinKey` reuse core's existing definitions.
- `pinsOf` and `PinRead` move alone from `collect/ledgers.ts`; their bodies are unchanged.
- `emptyReads` includes per-source `records`; `ReleaseState` extends the existing model without changing its consumers.
- The Store and `releases.json` constant become async `ReleasePersist.load/save`. Loading is lazy inside the coalesced read. Zod validates state (including optional legacy records defaulting to empty), rejects malformed persisted data and records load failures. Save errors record failure and reject; a pending save retries even inside cadence without refetching. Successful saves clear their failure record, and a `release-state`/`load` record is dropped before each load and after a successful one so it cannot keep evidence failed; `ReleasePersist.save` takes `ReleaseState`; callbacks follow successful saves only.
- Context supplies the clock, release repositories and forks. The fleet is copied at the start of the actual read; no module-level fleet defaults are used.
- Each release, creation-date and pin attempt records source/object/time/completeness/failure. Failed reads retain values and their own last-good timestamp, including repeated failures after persistence. Legacy state without records uses its aggregate `at` as the only available retention time.
- Creation-date reads inspect null/missing repositories and GraphQL errors per repository instead of silently ignoring them, matching each GraphQL error to its repository by `path` (`r<i>`) and falling back to a generic message; successful repository fields still update.
- Pin tree projection includes `truncated`; a truncated tree fails rather than caching incomplete pins. GraphQL partial pin failures retain the original retry behavior.
- Pins are cached for good once read, as in the rib, so `force` (the rib's Refresh) costs no per-tag calls. Only a pin that failed earlier or has no `github-pins` evidence record (legacy state) is re-read on a due read; the opt-in `refreshPins` option re-reads all and is never passed by Refresh.
- `JAVA_PROPS` is frozen to satisfy core's module-state boundary; `javaOf`, `pinPoms` and pin extraction bodies are otherwise unchanged. All GraphQL continues through `Gh`, which owns budget accounting.

## Additional proof

Collector tests cover exact cadence boundaries, in-flight coalescing, state round-trip, malformed state, retained values across restart, truncated pin trees, persistence failures, two interleaved fleets and charged GraphQL cost. Tests import owned modules directly; no barrels or dependency manifests change.
