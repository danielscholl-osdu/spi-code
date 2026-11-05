# Watch projection

`projectWatch` accepts Facts, release reads, area-grouped `SweepReads`, release
ReadRecords, the doctor summary, an explicit fleet context and the app data path.
It reads the context clock once and returns a `ViewSnapshotSchema`-parsed value.
It does not post messages, execute actions or register routes.
Before the first sweep, the required top-level `sweptAt` is the projection time,
not evidence of a completed sweep. `briefing.sweptAt` remains absent/undefined;
consumers must use that field to tell whether a sweep has occurred.

The tree uses evidence states, not service health: a stopped service can have
fresh evidence. Service dots use records naming that service, its repository or upstream;
whole-area failures use the sweeper's exact `source: area, object: area` shape
and apply to every service. Repository-shaped GitHub objects are not whole-area
reads. Shared template evidence may degrade a service with its own evidence
when stale or failed, but cannot give an unread service a state. Missing records
remain unread. Workflow run dots, including approval and lifecycle runs, use only
their repository's evidence (or an explicit area-wide record). System and Today
include release evidence. Threads remain unread until their milestone.
All records retain their completeness, failure, retained timestamp and inferred
marker. `intervalMs` is the caller's freshness interval.

`projectReleases` reads `<appData>/notes/YYYY-MM.json` through core's `parseNotes`,
then builds and validates the documents and pane. Missing files mean no notes;
invalid text means invalid notes; other file errors propagate. Projection never
creates folders or writes notes, and includes every release month without a cap.

`appActions` adapts core actions to the read-only inspector contract. Every item
has `disabledReason: "writes arrive at M4"`; a rib reason becomes
`eligibilityReason`. Confirmation and executable payloads do not cross this
boundary. Repeated action types get deterministic numeric suffixes, reserving
existing type names to avoid collisions. These M2 IDs are positional across
sweeps, not durable execution keys; `spicode-svy.1` owns stable target-based IDs
before M4 enables writes. Pending labels over 40 characters
produce a diagnostic in that action's eligibility reason without dropping the
other actions. Irreversible confirmations without a nonblank subject are rejected
before adaptation. The Re-run when deployable offer is retained, not filtered out.

Regenerate only the Watch fixture from the repository root:

```sh
pnpm run build
TZ=UTC bun scripts/watch-snapshot.ts
pnpm biome check --write fixtures/watch/snapshot-59d6895.json
```

The generator uses the pinned core fixtures, fleet, rollout and clock. It does
not regenerate or modify the rib oracles. Tests compare against those oracles
and reject a stale Watch fixture. Legacy fixture area timestamps are represented
as inferred records; production callers provide collector records unchanged.
