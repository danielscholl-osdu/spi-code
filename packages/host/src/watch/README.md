# Watch projection

`projectWatch` accepts Facts, release reads, area-grouped `SweepReads`, release
ReadRecords, the doctor summary, an explicit fleet context and the app data path.
It reads the context clock once and returns a `ViewSnapshotSchema`-parsed value.
It does not post messages, execute actions or register routes.
Before the first sweep, the required top-level `sweptAt` is the projection time,
not evidence of a completed sweep. `briefing.sweptAt` remains absent/undefined;
consumers must use that field to tell whether a sweep has occurred.

## Window projection seams

The strict Watch snapshot adds `substate` on every station, `attention`, optional
`due: { at, before }` and `owned` on every focus/rest item, plus `campaigns`,
`readings` and `seen`. The legacy `BriefingSchema` stays oracle-compatible;
`WatchBriefingSchema` requires the item additions at the snapshot boundary.
`substate.ts`, `attention.ts`, `campaigns.ts`, `readings.ts` and `seen.ts` own
typed hooks, wired once in `project.ts`, for later feature computations.
Stopped and moving stations trivially map to stopped and in-progress. All other
stations use neutral `ready` until the sub-state classifier ships; this default
does not assert health or distinguish a person from a clock. Items default to
ambient, unowned and no due time. Detected campaigns default to none.

Each program/place/service/release-month anchor has a reading entry whose
`content: null` means not computed, not an empty reading. The window must omit
it. Computed content has a headline, optional qualifier, exactly three tiles
(`label`, `value`, `counts`), up to five grouped items with the same strict
shape and identity as focus/rest records, and `folded` (null when nothing remains).
Campaign anchors use the same shape. Pins are window-local, not snapshot data.
`seen.cursor: null` means no acknowledged baseline. The window request
`view.acknowledge` carries `{ cursor }`; this bead defines its shape only,
not persistence or request handling.

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
focus, rest, ready, themes, horizon) name the model's contributing areas. An
unknown label or branch falls back to a superset rather than fewer areas.
Bindings never guess from record sources or object names. The running version
names lifecycle, or github and lifecycle when only the declared version is known. The `/releases`
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

## Inspector compatibility and optional selection fields

The optional top-level `services` list contains one entry per `service` id with
`runs` and `releases`. Older snapshots may omit it. It is separate from
`stations` so service-page evidence does not change Flow's station evidence.
Runs contain `id` (`run:<number>`), `workflow` (the recorded name),
`result` (conclusion for a completed run, status otherwise), `time` (creation
time) and `url`. They come from the existing fork, lifecycle and approval
reads, scoped to the service repository, deduplicated by repository and run id
and sorted newest first. The inspector uses the same recorded-run lookup. A run
with no recorded hit in its repository gets no provenance entry; it never fails
the projection.

Service release rows are the existing release document's `DocRow` plus `month`.
Only the current month adds the current release station's `gate` (`state`,
`text`) and, when open, `releasePr` (`number`, `title`, `url`). A current PR or
gate is never attached to a historical month. These rows feed the service page
only; the Releases pane and month documents are unchanged. Release-row evidence
retains the release reader's envelope alongside fleet and GitHub areas.

Every station has an optional `inspect`: the first four use `upstream:<service>`;
Release and Stack lane use `station:<service>:release` and
`station:<service>:lane`. Those host-only targets resolve from the recorded
line model, including its release PR, release tag or last lane deployment.
Repository lines add optional `id` and `url`, taken from their model objects.
Ids are `pr:<owner/repo>:<number>`, `issue:<owner/repo>:<number>` and
`alert:<owner/repo>:<group id>`; alert groups use core's filtered group URL.
A line the host cannot match to a model object keeps neither field, so a change
in core's wording drops the optional fields instead of failing the sweep. The
recorded fixtures assert that every line still gets both.
Their Detail result preserves the line's text, subtext and repository link.
Inspect results also carry an optional `title` from the existing model or row.
No new collector or executable action is introduced.

### Evidence compatibility

[`InspectResultSchema`](../../../contracts/src/watch/inspect.ts) accepts two shapes.
A legacy result has neither `areas` nor `provenance`. A modern result has both,
even when `provenance` is empty. Supplying only one is invalid.

Modern `areas` has exactly one envelope for each of the 11 names in
[`AREAS`](../../../contracts/src/watch/evidence.ts). Each envelope's `source`
must equal its `area`. Unread areas still have entries. Array order is not a
schema requirement.

Each provenance entry binds a value through an RFC 6901 JSON Pointer. Paths
must be unique, below the root and resolve within that inspector result.
For example, `/cause` names the cause and `/related/0` names the first related
row. Escape `~` as `~0` and `/` as `~1` within a path token. Each binding names
a nonempty list of distinct areas with envelopes. Its optional `envelope` carries
supplemental evidence outside the swept Facts areas.

[`WatchRoutes.inspect`](../process/routes.ts) passes the persisted snapshot's
`areas` unchanged to every inspector result. This covers queue items, rollout
steps, MRs, releases, repositories and their lines, upstream plans and forks,
services, stations, runs, holds and themes. Request time is used to rebuild the
model, not to refresh or rejudge those stored envelopes. All current host
results have `provenance: []`.
The presence of area envelopes does not establish a source for any value.

Per-value bindings remain deferred to `spicode-t1k.125`, `spicode-t1k.126` and
`spicode-t1k.127`. The contract permits them; the host does not yet emit them.
Inspector rendering of those bindings is `spicode-t1k.99`.

## Value sources and host state

A binding describes the reads that produced that value, not every read used
by its queue item. Use a union only when that value depends on those inputs.
A whole-item or whole-fleet union alone cannot establish which inputs produced
a cause, a related row or an action reason. Snapshot section
unions serve a different purpose: they show all feeding areas for that section.
Do not copy those unions into inspector field bindings.

The host currently leaves every inspector value unbound because core has not
recorded those per-value sources. Sources must not be reconstructed from item
class, displayed text, a ReadRecord's `source` or `object`, or the worst area
state. The schema checks the binding's shape and references, not whether an
area actually produced a value.

Some values need no Facts binding even when per-value sources arrive. Inspector
and action IDs identify objects. Fixed dispatch labels and
`disabledReason: "writes arrive at M4"` are host text, not observations.
`appActions` can also append a `pendingLabel` length diagnostic to an eligibility
reason. That diagnostic has no swept source.

An eligibility reason is not necessarily a read result. Core's
[`verbsOf`](../../../core/src/inspect/actions.ts) also uses host options and
sweep markers: write-scope checks, operations being disabled and an already-held
wait. Those inputs must not be assigned a Facts area just because the action
also uses one. A reason based on observed deployability needs the sources of
that branch, not the action's whole source union.

## Request-time FILTERS reads

For a checkable halt, `inspectResult` calls
[`entryAcrossForks`](../../../core/src/collect/filters.ts). It reads each other
fork's filter file and upstream tree at request time. These reads can be newer
than the stored sweep. Each record keeps its source, object, observation time,
completeness and any failure. The route deduplicates identical records into
`evidence`; it does not replace the persisted area envelopes.

FILTERS results can change the next step and add related rows. Current results
still have empty provenance. They contain no per-row FILTERS envelope, and
`evidence` is not a field-to-read mapping.

The contract's supplemental `envelope` can represent request-time evidence
without inventing a new Facts area or overwriting a swept one. The example
below illustrates that shape, not current host output. Per-row read attribution
and host mapping remain deferred. A row needs only the fork reads that produced
it, not every FILTERS read across the fleet. A combined absent-entry row may
use several forks. The envelope must be judged from those contributing reads;
an unrelated fork's failure must not mark a successful row failed.

## Window evidence helpers

[`store/evidence.ts`](../../../../apps/window/src/store/evidence.ts) shares the
`areas` and `provenance` shape used by snapshots and modern inspector results.
Legacy inspector results have neither field. They must not borrow a snapshot's
provenance or manufacture bindings to fill that gap. Skip value-specific helpers
for legacy results; pass a modern result's own evidence pair to them.

`envelopesFor` matches bindings at, below or above a pointer, on path-token
boundaries. A row binding therefore supplies area badges for its child fields.
`envelopesForAll` unions matches for several prefixes, without duplicates, in
the payload's area order. These helpers return swept area envelopes only.
They do not return a binding's supplemental envelope.

`isInferred` requires an exact pointer match. Every named area must have
`inferred: true`, and a supplemental envelope, if present, must also have
`inferred: true`. Missing provenance, an unmatched child pointer, or an observed
input returns false. False means no inferred-only claim, not proof of an
observed source.

[`AreaEnvelopes` and `InferredMark`](../../../../apps/window/src/components/evidence/AreaEnvelopes.tsx)
use these helpers. Empty provenance yields no value-specific area badges or
inferred marks, even if an available area envelope is inferred. The helpers do
not guess sources, recompute freshness or assume a sweep interval. The host
supplies the envelope state.

The current [`RightPanel`](../../../../apps/window/src/panels/RightPanel.tsx)
does not consume inspector `areas` or `provenance`. It marks individual
`evidence` records when their own `inferred` flag is true.
[`ReadList`](../../../../apps/window/src/components/evidence/ReadList.tsx)
shows record times, cuts and failures without deriving an envelope. Neither
path makes unbound inspector fields inferred.

## Watch fixtures

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
not regenerate or modify the rib oracles. The host parity comparison removes
only the additive contract fields before comparing the original values to those
oracles, and tests reject a stale Watch fixture. Legacy fixture area timestamps
are represented as inferred records; production callers provide collector
records unchanged.

## Appendix A: synthetic contract examples

These are payloads and bindings, not port message wrappers or real sweep data.

A legacy payload parses without either provenance field:

```json
{
  "id": "service:example-fork",
  "class": "READY",
  "cause": "No queued work",
  "effect": "",
  "next": "",
  "why": "",
  "evidence": [],
  "related": [],
  "approval": null,
  "actions": []
}
```

This modern payload uses the current host shape. Its FILTERS reads are
request-time evidence. Its area envelopes remain sweep-time evidence. Empty
provenance leaves all values unbound:

```json
{
  "id": "halt:example-fork",
  "class": "HALT",
  "cause": "An upstream entry needs classification",
  "effect": "Sync is stopped",
  "next": "Read the other fork's filter",
  "why": "",
  "evidence": [
    {
      "source": "example-org/example-peer",
      "object": ".github/upstream-filter.yml",
      "observedAt": "2026-01-15T12:01:00Z",
      "completeness": { "kind": "complete" }
    },
    {
      "source": "example-group/example-peer",
      "object": "repository/tree?ref=master",
      "observedAt": "2026-01-15T12:01:00Z",
      "completeness": { "kind": "complete" },
      "failure": "Synthetic upstream read failure"
    }
  ],
  "related": [{ "text": "example-peer", "state": "?" }],
  "approval": null,
  "actions": [],
  "areas": [
    {
      "area": "fleet",
      "envelope": {
        "source": "fleet",
        "state": "fresh",
        "observedAt": "2026-01-15T12:00:00Z",
        "completeness": { "kind": "complete" },
        "inferred": false
      }
    },
    {
      "area": "github",
      "envelope": {
        "source": "github",
        "state": "fresh",
        "observedAt": "2026-01-15T12:00:00Z",
        "completeness": { "kind": "complete" },
        "inferred": false
      }
    },
    { "area": "runs", "envelope": { "source": "runs", "state": "unread" } },
    { "area": "approvals", "envelope": { "source": "approvals", "state": "unread" } },
    { "area": "lifecycle", "envelope": { "source": "lifecycle", "state": "unread" } },
    { "area": "details", "envelope": { "source": "details", "state": "unread" } },
    { "area": "upstream", "envelope": { "source": "upstream", "state": "unread" } },
    { "area": "radar", "envelope": { "source": "radar", "state": "unread" } },
    { "area": "template", "envelope": { "source": "template", "state": "unread" } },
    { "area": "auth", "envelope": { "source": "auth", "state": "unread" } },
    { "area": "security", "envelope": { "source": "security", "state": "unread" } }
  ],
  "provenance": []
}
```

This array illustrates `ValueSourceSchema` bindings and a supplemental
request-time envelope. Replacing the modern payload's `provenance` with it
also parses as `InspectResultSchema`. It does not assert that the current host
has attributed these values:

```json
[
  { "path": "/cause", "areas": ["github"] },
  {
    "path": "/related/0",
    "areas": ["fleet"],
    "envelope": {
      "source": "filters",
      "state": "failed",
      "observedAt": "2026-01-15T12:01:00Z",
      "completeness": { "kind": "complete" },
      "inferred": false
    }
  }
]
```

`filters` is a supplemental source label here, not a twelfth area.
`envelopesFor` would return the fleet envelope for `/related/0`.
The failed supplemental envelope is separate; an area-only badge cannot
show that failure.
