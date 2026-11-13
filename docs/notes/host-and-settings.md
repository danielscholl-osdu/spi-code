# Host, sweep and Settings behaviour

What builders recorded about the host's setup and sweep messages, notifications, Readiness and the shared Sweep control. The code and its tests are the authority; these notes say what is not obvious from them.

Copilot tool observations have no SDK turn key: the host binds their sender to the
active serialized turn; a callback from an earlier turn arriving during a later
turn cannot be distinguished. Callbacks outside a turn are logged and dropped.

The host's stores borrow one `openStore` connection; only `openRunStore` owns an
extra connection for external callers. Snapshot pruning stays outside the write
transaction, so a daily retention failure reports an error without undoing a sweep.

The host's `setup.check` request rechecks every readiness row, bypasses the Copilot
seat cache, and publishes `setup.state` with the check time in `checkedAt`, even
when readiness is unchanged. Ordinary refreshes retain the last check time.
Concurrent requests share one check. After publishing readiness, a five-second,
abortable read of GitHub's REST `rate_limit` endpoint refreshes the GraphQL points
without entering the sweeper's reservation queue. It runs only when gh is usable
and merges the figures into the latest `sweep.status`, retaining its floor,
deferred areas, next sweep, schedule and last sweep. Failed budget probes report unavailable points rather than stale
ones. Older state fixtures may omit the timestamp; tests use fixture tools and
never a live credential or Copilot seat.
The host always publishes `forceCooldownUntil` in `sweep.status`: the epoch-millisecond
deadline 60 seconds after the last forced sweep ended, or `null` when no cooldown
remains. Joined and cooldown-downgraded requests, and later ordinary sweeps, do not
move this session-only anchor. Failed and cancelled forced sweeps start it too.
Expiry publishes `null`; subscription replay also clears expired deadlines and
keeps snapshot, progress, status order. The field is optional in the contract
so existing fixtures still parse.
Consumers treat an absent or past deadline as no cooldown.
Desktop Interrupt notifications consume committed snapshot tiers and `seen.since`,
coalescing new or worsened items into one native banner per sweep. Dedupe keeps the
most severe notified rung per item, only in memory for the app run; a focused
BrowserWindow suppresses delivery, not a merely
visible one. The first snapshot after relaunch summarizes unacknowledged Interrupts;
the first-ever sweep keeps its existing "Today is ready" hand-over. Acknowledgements
on the outgoing host channel close covered native handles without changing the
snapshot or Today count. Clicks open Today with the item selected through the
validated preload/renderer route. Both layers limit item ids to 256 UTF-16 code
units and reject blank or edge-whitespace ids, control characters, Unicode
line/paragraph separators, the reserved names __proto__, constructor and prototype,
any .. path segment, %2e in either case, and .. adjacent to / or %2f in either case.
Other percent encodings, including campaign ids containing %20, stay valid.
They reject path and URL shapes while retaining namespaced repository-qualified
ids; the renderer extends IdentifierSchema locally, without changing contracts.
Banners use bounded, single-line item titles, truncate by code point, redact
credential shapes and absolute/home paths, and never read diagnostic fields.
Readiness shows Copilot, git, gh and glab in that order, with no action on ready
rows. Settings → Sweep holds the GitHub API budget; Readiness keeps a one-line
link to it. Sign-in codes and GitLab tokens stay in their own
fields; waiting gh and Copilot sign-ins offer Cancel. Check all stays disabled
until its request-correlated `setup.state` arrives after the budget read. An
uncorrelated readiness refresh can update the Checked time without unlocking
the check; a correlated failure or a host reconnect releases it for retry.
If the host supervisor gives up, pending checks and sign-ins are cleared before
the stop message is surfaced, so the Readiness controls do not stay locked.
The shared `components/sweep/SweepNow` control takes `onViewSweep` and
`onOpenReadiness` callbacks; its parent closes Settings before opening the
requested destination. It calls the store's `requestSweepNow` forced path, while
`requestSweep` remains the non-forced Try again path. Saved feedback waits for
the requested sweep's terminal progress, status and committed snapshot.
`forceCooldownUntil` is the host's session-only deadline, not a local guess from
`lastSweep.requested`; the control expires it and retry promises on its own
clock even when no further status arrives. Joining a routine sweep follows it
without a forced follow-up.
Evidence reuses that control beside its saved or live sweep time; View sweep there
keeps Evidence open. Its next sweep time and the freshness field's hover and
accessible name disappear at the scheduled deadline, without waiting for another
host event. The strip's compact visible time and source counts stay unchanged.
The first not-ready setup state opens Settings on Readiness once over the Watch
gate. Its banner names only blocking git and gh states; tools that need an update
remain usable, and Copilot or glab attention does not block Watch. The gate offers
Open Settings after the dialog closes. Host readiness, the banner and the window's
test fixtures share the contracts' `blocksWatch` predicate, whose tests pin usable
updates. If Watch becomes ready while Settings is open, the
banner turns green with Go to Today; Settings stays open, and either that button
or closing the dialog lands on Today. A later readiness loss opens nothing, and
ordinary Settings visits preserve the place behind them.

An inspect id resolves through `resolveInspect` in `packages/host/src/inspect/resolve.ts`,
outside the `inspect.request` route, so thread context or Diagnose can ask the same
question. Its table is ordered and only the first row that claims an id answers; a new
id kind is a new row, and a row whose lookup finds nothing answers undefined.
A row that composes a time passes `deps.ctx` on (core's boards take it as `context`), so
the app's instant style reaches Detail; `fixtures/watch/inspect-1106.json` is answered in
that style, and `inspect/instants.test.ts` fails on a clock time in any kind's answer.

The host package emits declarations, so an exported watch step whose inferred return type reaches a core type core does not export (`Since`, `HorizonStages`, `PlaceRow`) fails `tsc` with TS2883 or TS4058. Spell the return type from exported types and `ReturnType<typeof fn>`, as `ProjectedBriefing` in `watch/briefing.ts` does.
