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
marker. `intervalMs` is the caller's default freshness interval; release records
use the release reader's `RELEASES_EVERY_MS` cadence.

`areas` carries one envelope per area, in core's `AREAS` order, from core's
`envelopeOf` over that area's reads. An area with no reads is unread. Each area
uses `intervals[area]` when given, otherwise `intervalMs`, as does the tree.
`provenance` maps JSON Pointers into the snapshot to the areas
that fed each drawn value. Every rendered briefing and station value has an
entry at its own pointer or an ancestor's; the only exceptions are read
metadata, the clock window, inspector ids and fleet service names. Bindings in
`provenance.ts` follow core's builders and name only the areas that fed the
value, per fact label, flow tile label, repository cell and station branch, so
a value drawn only from inferred reads reads as inferred. For example, a release
station names github, a lane held by the stack names lifecycle, and a clean sync
names github and runs. Values that judge the whole model (headline, summary,
focus, rest, ready, themes, horizon) name every swept area. An unknown label or
branch falls back to a superset rather than fewer areas. Bindings never guess
from record sources or object names. The running version names lifecycle, or
github and lifecycle when only the declared version is known. The `/releases`
section and each release line name the fleet area and carry an `envelope` for
the release reader's own ReadRecords. This non-area envelope leaves Facts areas
as swept collectors and avoids changes to the sweeper or snapshot store. It
uses core's `envelopeOf` and the release reader's cadence, including retained
times, cuts, failures and inferred-only status. The section envelope is present
even when there are no release lines. The Releases section badges it alongside
the fleet envelope; non-fresh release evidence marks each line in both list and detail.
A line says inferred only when its release reads and feeding areas are all
inferred. The contract rejects a snapshot whose provenance
path does not resolve or names an area without an envelope.

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

Regenerate only the Watch fixtures from the repository root:

```sh
pnpm run build
TZ=UTC bun scripts/watch-snapshot.ts
pnpm biome check --write fixtures/watch/snapshot-59d6895.json fixtures/watch/snapshot-mixed-59d6895.json
```

The mixed fixture (`mixedFixtureInput`) keeps only lifecycle reads inferred and
marks every other area and the release reads observed, so the window's evidence
helpers can tell inferred values from observed peers.

The generator uses the pinned core fixtures, fleet, rollout and clock. It does
not regenerate or modify the rib oracles. Tests compare against those oracles
and reject a stale Watch fixture. Legacy fixture area timestamps are represented
as inferred records; production callers provide collector records unchanged.
