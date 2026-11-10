# How work moves in spi-code

Work is tracked in beads, built in parallel worktrees, reviewed adversarially by a different provider, and landed on `main` by a gate script. GitHub issues and pull requests are not part of the path. This is a starting point; change it when something doesn't work.

```
epic ──breakdown──▶ beads ──claim──▶ worktree ──build──▶ review ──land──▶ main
  (when we start)     (wave plan)    (one per bead)    (other provider) (scripts/land)
                                                                          │
                                       stop the line ◀── main breaks ◀────┘
```

## Pieces

| Piece | Role |
|---|---|
| **bd** (beads) | Source of truth for work: epics, beads, dependencies, claims, review results, the merge slot. Prefix `spicode`. Lives in `.beads/`, git-ignored and local to this machine. Every worktree finds it through git's common directory. |
| **Keelson beads board** | Where you watch it: the Epics wave map, In flight claims, Your calls (decisions waiting on you), Shipped. `beads-next` picks a bead; `beads-groom` checks backlog health. `beads-work` is not used, because it is built around draft PRs. |
| **Keelson workflows** | `adversarial-review` for high-risk beads (three lenses plus a verifier, with the author's model excluded). `design-converge` when a bead hits a real design fork. `investigate` when a fact needs establishing first. |
| **T3 Code** | The main place work is dispatched from: one delegated agent per bead, each in its own worktree, mixing Claude, Codex and Gemini. |
| **`scripts/check`** | The checks every bead passes before review and before landing. Installs the pinned dependencies with `pnpm install --frozen-lockfile` if `node_modules` is missing, then runs `pnpm run check`: Biome, a strict TypeScript build, Vitest and source license headers. |
| **`scripts/land`** | The only way onto `main`. It is deterministic, so it behaves the same whichever harness or model calls it. |
| **GitHub** | Not set up yet. When M0 needs CI for signed builds, `main` gets a remote and Actions runs on it. `scripts/land` pushes once a remote exists. No issues and no PRs. |

## 1. Epics, created up front

There is one epic per milestone (M0 to M7). Its description is the PRD's milestone row and the requirement IDs it ships. The PRD's open maintainer questions are `decision` beads, so they show under Your calls. Nothing finer is planned until an epic starts.

## 2. Breakdown, when an epic starts

Skill: `epic-breakdown`. One agent breaks the epic into beads:

- **Size:** one worktree and one reviewer per bead, and roughly 400 changed lines or less.
- **Requirements:** each bead names the PRD requirement IDs it satisfies. Its acceptance criteria are their "Verified by" checks, made concrete.
- **Dependencies:** set with `bd dep`, so `bd ready` shows what can run at once. `bd swarm validate` confirms the graph.
- **Risk:** label `risk:high` for credentials, the sandbox, approvals and tiers, durability and intents, and the Copilot session boundary. Label everything else `risk:std`.

A reviewer from another provider checks the breakdown. The maintainer then approves it once, and the epic gets the `breakdown:approved` label. **This is the human gate: once per epic, not once per change.**

## 3. Allocate

`bd ready --parent <epic>` lists the current wave. Each ready bead goes to one agent in its own worktree. Keep 3 or 4 in flight, spread across providers so a reviewer from another provider is always free.

The agent claims the bead atomically with `bd update --claim`, under a worker name of its own (`--actor`), because bd treats a repeat claim by the same actor as success. `bd heartbeat` keeps a long claim alive, and `bd reclaim` returns the beads of crashed agents to the queue.

## 4. Build

Skill: `bead-build`. Work happens only in the bead's worktree, on branch `bead/<id>`, never in the main checkout. Commits use `aipr` with a `Bead: <id>` trailer. Run `scripts/check` before asking for review. Anything outside the bead's acceptance becomes a new bead.
`scripts/land` rejects AI co-author trailers and "Generated with" lines in incoming commits; human co-authors and existing `main` history are allowed.

The scaffold uses Node 22.16 or newer, matching `engines` in `package.json`, and pnpm 10 (the exact pnpm version is in `package.json`). `node:sqlite` is unflagged from 22.13, but the host store also needs `DatabaseSync.isTransaction`, which arrived in 22.16.
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
for existing fixtures, so protocol version 3 and the desktop preload stay unchanged.
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
`pnpm run build` compiles all six workspaces; `pnpm run lint`, `pnpm run typecheck`,
`pnpm run test` and `pnpm run check:headers` run individual checks. Vitest discovers
`src/**/*.test.ts` and `src/**/*.test.tsx` in each workspace, plus script tests.
The header check covers tracked and untracked, non-ignored sources, including
extensionless shebang scripts. Build output and dependencies are ignored.

The window's `app/text-rules.test.tsx` renders every Watch fixture across its places,
strip, Line sheet, sidebar, command palette and Detail kinds. It checks headline length,
internal names, title emoji and empty or placeholder sections, with rule mutations.
Injected emoji cases cover Detail fields, Today sublines, template queue rows and
environment repository lines; ordinary symbols and navigation glyphs stay intact.

Core and window duration formatters share `timeUnit` from contracts. It binds each
number to its unit with U+00A0; compound durations may wrap between pairs. Title
cleanup preserves those bindings. After changing core time copy, regenerate Watch
fixtures with `TZ=UTC bun scripts/watch-snapshot.ts` after building, then format
`fixtures/watch`. Recompute the models digest with
`SPI_RECORD_MODEL_DIGEST=1 pnpm vitest run packages/core/test/inspect/identity.test.ts`.
The frozen rib oracle stays unchanged; its comparison ignores only U+00A0.

Window layout tests keep logical sections flat and reserve `.card` for separate
objects such as repository fact summaries. The shell calls the width budget on
resize and pane toggles, narrowing Detail, moving it to a sheet, stacking pinned
Line context and finally moving the sidebar off-canvas. The eight drawn cases are
covered together in the shell test. The desktop sets a 740 px content minimum;
the renderer clamps smaller viewports before budgeting. The title bar and strip share
one 44 px top row; the place name is in the centre header and the OS title stays
`SPI Code · <place>`. The pips share one Line button with aggregate state counts;
each full-height pip target retains its service context menu, also reachable from
the service's Line sheet row. Status field buttons open Line and Cmd-L still toggles it.
Freshness is the last field: a muted, amber or red dot, the sweep time and an
affected-source count. Its hover and linked accessible label spell out failed,
incomplete and stale counts; unread sources are named too. Cut reads count as
incomplete but stay red, as do failures; other incomplete or stale reads are amber.
It opens the sweep's Evidence. The row's inset divider leaves the full 44 px for targets,
and pip marks themselves never take focus from their button.
The shell measures the row into `--topbar-height`; narrow sidebar and Detail sheets
and their backdrops use that offset, fall back to 44 px before measurement,
and update when the row resizes.
Opening a collapsed sidebar uses the budget for its open state, so one shortcut
opens it off-canvas after narrowing. Clearing a selection closes a Detail sheet;
inline sweep Evidence may stay open. Resizing an inline sidebar off-canvas moves
focus out of its hidden content to the sidebar toggle.
Pane headers share the 44 px `pane-header` rule. The centre reads left-aligned at
most 960 px wide with 20 by 24 px padding; its full-width place header stays above
the scrolling body. The Line body also scrolls below its header and contains its
absolutely positioned accessibility labels. Service source sections use named, styled disclosures,
with nonempty Attention open by default.

`scripts/check` repeats Vitest with `SPI_TEST_CLOCK_SHIFT=1`, moving the wall
clock 400 days forward to catch expiring fixtures before they break main.
The shifted clock still ticks, leaves real timers alone, and allows explicit
fake clocks. Both passes respect `VITEST_MAX_WORKERS`. Tests with dated fixtures
should inject a clock or pin their own fake time rather than read today's date.

`scripts/check` also validates production dependency licenses offline and writes
`build/THIRD_PARTY_NOTICES.md`. `package:mac` repeats generation against the staged
production install plus the renderer's production dependency closure, then ships
the result in `Contents/Resources/THIRD_PARTY_NOTICES.md`. Missing license text or
an identifier outside the generator's allowlist fails the build. Electron's
`LICENSE.electron.txt` and `LICENSES.chromium.html`
remain supplied by electron-builder.

`package:mac` copies the workspace manifests and tested `pnpm-lock.yaml` into
staging and installs production dependencies with `--frozen-lockfile` before
adapting the manifests for electron-builder. A manifest/lockfile mismatch fails
packaging. Manifest discovery uses pnpm's workspace patterns and exclusions rather
than a separate directory list. The packaged smoke test runs the app extracted from
the generated ZIP, including the shipped runtime handshake, rather than the
builder's app directory.
Before starting the host proof, it renders `fixtures/watch/snapshot-1106.json`
at 1440, 900 and 740 x 800 content bounds and pins the app's Appearance selector
to light and dark. `build/package-<mac|win>/views/` holds 180 PNGs, a side-by-side
`index.html` review report and a copy of the window layout design. `smoke.json.views`
lists every surface/viewport width/appearance combination, its image and DOM
qualifier evidence, and its measured geometry. Missing combinations fail.
Every surface also measures the viewport, document scroll size and visible pane
envelope. Its left, right and bottom edges must meet the window, and the page
must not scroll in either axis. The wide four-pane probe checks individual
adjacency and edges; each header spans its pane's interior width, excluding only
the divider border, never a scrollbar gutter.
Settings includes first-launch Readiness over the Watch gate, failed glab sign-in,
ready Readiness and Appearance. The smoke pins its renderer clock to Nov 6,
09:04 America/Chicago, including `checkedAt`, so the Checked time and reset hint
are the same on both platforms and in both test time zones.
Sign-in requests are intercepted in the smoke-only preload path: no live token,
sign-in or tool probe is used. Dedicated probes measure a long Related label
and values at a 280 px panel, flush panes with 1 px dividers, three aligned 44 px
pane headers, Settings' 820 x 560 maximum and 24 px edge margins, and a contiguous
48 px first-row drag span at 740 px with 20 services. Only the Related and
20-service probes vary the projection; hand-made rect mutations exercise each
failure rule in unit tests. The existing smoke artifact uploads all evidence on
both platforms. Once per packaged run the renderer also shrinks a real Related
value to 159 px, records the expected rejection in `rejectedGeometry`, then
restores the value before capturing it. Missing rejection evidence fails.
The fixture clock, pane preferences and sign-in interception
are removed before the host proof, so they cannot affect its persisted-snapshot
and supervision checks. The 180-capture matrix has a six-minute smoke deadline.
Settings → Sweep adds idle, sweeping, saved-with-a-failure and Watch-not-ready
surfaces; Evidence adds idle and sweeping headers. Schema-valid status, progress
and snapshot fixtures pin future next-sweep and budget-reset times. The named
header, schedule and control must fit inside the panel and viewport. At 740 px,
the native picker selects Sweep and every cadence and labelled last-read cell
sits below its source. Consecutive Sweep states reuse the renderer with increasing
snapshot cursors rather than reloading it.
Seven first-sweep surfaces add a running list with failed sign-in and budget deferral,
throttling, stops while reading and while saving, a place before its first snapshot,
the retained list in Evidence after hand-over, and a refresh over the older brief.
Each joins the same width/appearance matrix and runs the window edge, page scroll
and visible pane header rules. First-sweep state copy is recorded in the qualifiers;
Open Settings, resume and retry times, the cut count and the refresh count are required.
Evidence groups failed reads by window source and cause, naming the affected
fleet ids in the Sources list's two-column row form. Causes use window words;
core's diagnostic text is available on an aria-hidden mark's hover, never inline
or as the row's accessible name.
Repo-backed records without an area use the forge's window source.
Known recorded sources map explicitly to their window source: release collectors to
Release lines, sign-in tools to Sign-in, and local saves or discarded caches to
Local state or Saved reads without a service list. Unknown sources use Other reads.
Pin keys lose their version before naming a fleet id.
The retained Evidence capture scrolls Failed reads away from the panel's edge:
end alignment can round a quarter pixel outside the panel at CI's 1x display scale.
After paint it records and asserts both bounds and exact row wording under the
`failed-reads` geometry rule, independently of time formatting or the clock.
The screenshot phase precedes host startup, so these schema-valid `sweep.progress`
fixtures use the same smoke-only preload channel as `view.snapshot` and `setup.state`,
not the real host progress feed. The later persisted-snapshot and supervision proof
starts only after removing fixtures.
The launcher and in-app deadlines share one six-minute budget: Windows CI's
180-capture run reached the last 740 px appearance at the former four-minute
deadline, before the host proof could run. Per-DOM waits and all geometry/image
gates are unchanged.
Missing shots, images smaller than 640 x 400 or 1024 PNG bytes, or images
with 99.5% of pixels in one 4-bit-per-channel RGB bucket fail the smoke.
Every shot must carry the title-bar sweep line (first-sweep captures carry its
running or waiting form); Today, Upstream, the selected
Detail's place and the affected service must also carry their failed-read or
truncation qualifier. The report names the corresponding window-design section;
the reviewer records match or mismatch per surface on the bead, not the smoke.
The listener scan checks the main pid and every app descendant, including the
Copilot runtime before it stops. Each scan takes one socket snapshot (`lsof` on
macOS, `netstat -ano` on Windows), followed by one process-table snapshot (`ps`
or CIM). Start times exclude stale parent links and reused pids; exited
processes need no liveness probes. Both queries share an eight-second budget.
`smoke.json` records the runtime scan's `scannedPids` and `scanDurationMs` under
`runtime.listenerCheck`. `scannedPids` lists only the pids the socket snapshot
sampled, never the scan's own `ps` or PowerShell, and the packaged gate fails
unless it holds the main, host, runtime and renderer pids and the duration is
under eight seconds. The scan runs after the handshake, without extending
the host's hello deadline.
Runtime staging excludes compiled `*.test.*` files and `smoke-launch.*`, including
their declarations and maps, across the desktop and bundled workspace libraries.
The in-app smoke modules remain bundled; the launcher runs from the build checkout.
The renderer's turn spike is a headless test harness in `apps/window/src/index.tsx`,
enabled only by `window.spi.proof` for packaged smoke and live proof runs. No page
renders a turn panel or composer; the harness still pings the host and starts one
turn per renderer load when the model catalog arrives.

Pinned notice repairs in `scripts/third-party-notices.mjs` cover npm archives
that omit their upstream MIT text: Copilot SDK/platform 1.0.26 uses the GitHub
MIT notice from `github/copilot-sdk` LICENSE (blob
`28a50fa22639e32febe14e4ffc7a732b0ba8c90a`); Koffi platform 3.2.1 uses the
matching installed `koffi` package's LICENSE.txt. Other missing notices fail;
version updates require rechecking these repairs. Supplemental shipped notices
are retained too. `scripts/licenses/t3-code-MIT.txt` preserves T3 Code's LICENSE
for copied/ported portions, following its `docs/internals/open-source-licenses.md`.

## 5. Review

Skill: `bead-review`. The reviewer comes from a different provider than the author. The review is read-only against the bead's acceptance and `git diff main...bead/<id>`.

| Tier | Review |
|---|---|
| `risk:std` | One reviewer from another provider, up to 3 rounds. Stop when only nits remain. |
| `risk:high` | Keelson `adversarial-review` (`subject=bead/<id>`, `author=<model>`), or a three-provider council. |
| `review:exempt` | None. Only for Markdown outside `design/`, `.agents/` and `AGENTS.md`, which `scripts/land` enforces. |

A pass is recorded as bead metadata, which `scripts/land` reads:

| Key | Holds |
|---|---|
| `build.provider`, `build.model` | Who built the bead (set at claim) |
| `review.provider`, `review.model` | Who reviewed it |
| `review.verdict` | `pass` |
| `review.patch_id` | `git patch-id --verbatim` of the reviewed diff |
| `land.sha` | The commit `scripts/land` put on `main`, so a rerun after a failed push can finish |

A clean rebase keeps the patch-id. Any change to the diff, whitespace included, voids the review.

## 6. Land

Skill: `bead-land`. `scripts/land <id>`:

1. Refuses while a `main-broken` bead is open, unless this bead is that fix.
2. Takes the merge slot, so landings happen one at a time.
3. Syncs `main` from the remote if there is one, rebases the bead onto it, installs the pinned dependencies (the rebase may bring new ones), and runs `scripts/check`.
4. Verifies the review: a pass whose patch-id matches, from a provider other than the author's.
5. Checks again that `main` isn't broken, then fast-forwards `main` to the exact commit it checked. It pushes, closes the bead with "Landed <sha>", and cleans up worktrees under `.worktrees/`. If the push fails, the bead stays open, and rerunning the script finishes the landing.

Agents land their own beads once these gates pass. History stays linear, and `main` always equals a tree that passed the checks.

## 7. Stop the line

Skill: `stop-the-line`. When `main` breaks, open a P0 bug labelled `main-broken`. `scripts/land` then refuses everything else. Revert if the cause isn't clear within about 30 minutes; otherwise fix forward. The fix gets a `risk:std` review and lands. If the break got past `scripts/check`, the fix adds the missing check.

## Not doing yet

- A project Keelson workflow or factory-mode swarm that runs breakdown, dispatch and landing on its own. Worth it after the manual loop has run through one epic.
- GitHub branch protection. With no PRs, `scripts/land` and CI on `main` do that job.
- Planning beyond epics.
