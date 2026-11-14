# Packaging and the packaged smoke

How `package:mac` and `package:win` stage the app, what the smoke captures and measures, its time budgets, and the listener scan.

`package:mac` copies the workspace manifests and tested `pnpm-lock.yaml` into
staging and installs production dependencies with `--frozen-lockfile` before
adapting the manifests for electron-builder. A manifest/lockfile mismatch fails
packaging. Manifest discovery uses pnpm's workspace patterns and exclusions rather
than a separate directory list. The packaged smoke test runs the app extracted from
the generated ZIP, including the shipped runtime handshake, rather than the
builder's app directory.
Before starting the host proof, it renders `fixtures/watch/snapshot-1106.json`
at 1440, 900 and 740 x 800 content bounds and pins the app's Appearance selector
to light and dark. `build/package-<mac|win>/views/` holds a PNG per shot, a side-by-side
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
and supervision checks. The whole capture matrix runs inside `SMOKE_TIMEOUT_MS`.
Settings → Sweep adds idle, sweeping, saved-with-a-failure and Watch-not-ready
surfaces; Evidence adds idle and sweeping headers. Schema-valid status, progress
and snapshot fixtures pin future next-sweep and budget-reset times. A single
description of each sweep supplies its source outcomes, observations, retained
reads, area envelopes and supplemental provenance. A source not due is skipped
and keeps its earlier observation. Running captures retain the last committed
snapshot and completed source list separately from the live sweep's progress;
in-flight reads do not become saved observations before commit. The named
header, schedule and control must fit inside the panel and viewport. At 740 px,
the native picker selects Sweep and every cadence and labelled last-read cell
sits below its source. Consecutive Sweep states reuse the renderer with increasing
snapshot cursors rather than reloading it. Every new surface also checks its
interactive targets against Electron's drag shape. Settings requires its full
backdrop to be clear of drag rectangles; Evidence includes its backdrop when
presented as a sheet. The separate nine-overlay probe still loads once and
resizes each open overlay through minimum, launch and wide sizes.
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
The launcher's child-process hard limit (`apps/desktop/src/smoke-launch.ts`) and
the in-app smoke watchdog (`apps/desktop/src/index.ts`) both use `SMOKE_TIMEOUT_MS`,
480,000 ms in `apps/desktop/src/smoke-report.ts`. Both limits must allow the capture
matrix, overlay checks and host/runtime proof to finish: raising only one leaves the
other able to terminate a healthy run. The launcher starts its deadline first, so it SIGKILLs a stuck app before the later-starting in-app watchdog can report.
The non-smoke proof watchdog stays at 120,000 ms. Per-DOM waits and all
geometry/image gates are unchanged.
Today is also captured on the calm, busy and bad mornings (`snapshot-calm.json`,
`snapshot-busy.json`, `snapshot-bad.json`, each passed by its own
`--smoke-views-<morning>-fixture` flag) at 1440 and 740 px in both appearances, and
with Detail open at 1440 px. Each image holds Today's whole pane: the pane is captured
strip by strip as it scrolls and joined, and each shot records its blocks' positions
in the image, the decision.md sections it answers to, and, on the bad morning, the
caveat band's text.
Missing shots, images smaller than 640 x 400 or 1024 PNG bytes, or images
with 99.5% of pixels in one 4-bit-per-channel RGB bucket fail the smoke.
Every shot must carry the title-bar sweep line (first-sweep captures carry its
running or waiting form); Today, Upstream, the selected
Detail's place and the affected service must also carry their failed-read or
truncation qualifier. The sweep segment opens a popover, so probes reach the sweep's
Evidence through its Evidence button (`openSweepEvidence`); at 1440 px
`views/sweep-states-<appearance>.html` holds the segment idle, stale, failed, sweeping
and open. The report names the corresponding window-design section;
the reviewer records match or mismatch per surface on the bead, not the smoke.
The listener scan checks the main pid and every app descendant, including the
Copilot runtime before it stops. Each scan takes one socket snapshot (`lsof` on
macOS, `netstat -ano` on Windows), followed by one process-table snapshot (`ps`
or CIM). Start times exclude stale parent links and reused pids; exited
processes need no liveness probes. Both queries share an eight-second budget on
macOS and a 30-second budget on Windows. Windows CIM requests only process ids,
parent ids, command lines and creation times. Command failures (including timeout
SIGTERM) retry at most three times with a 250 ms backoff; each query gets at most
15 seconds within that shared deadline, allowing a cold runner more than the
former eight seconds. Invalid process rows, missing app processes and listeners
fail without retry. The runtime-report wait allows the scan budget plus seven
seconds; the host hello and whole-smoke deadlines are unchanged.
`smoke.json` records the runtime scan's `scannedPids` and `scanDurationMs` under
`runtime.listenerCheck`, alongside `processQueryAttempts`, the successful process
query's one-based attempt. Exhaustion reports the attempt count and command
failures. `scannedPids` lists only the pids the socket snapshot
sampled, never the scan's own `ps` or PowerShell, and the packaged gate fails
unless it holds the main, host, runtime and renderer pids and the duration is
under its platform's shared budget. The scan runs after the handshake, without extending
the host's hello deadline.
Runtime staging excludes compiled `*.test.*` files and `smoke-launch.*`, including
their declarations and maps, across the desktop and bundled workspace libraries.
The watch fixture builders compile from `packages/host/test` to `packages/host/build`,
which is never staged; staging also drops any `snapshot-fixture` or `detail-feed`
module an older build left in `packages/host/dist/watch`.
The in-app smoke modules remain bundled, and desktop main imports `smoke-run.ts` only
under `--smoke`; the launcher runs from the build checkout.
The renderer's turn spike is a headless test harness in `apps/window/src/index.tsx`,
enabled only by `window.spi.proof` for packaged smoke and live proof runs. No page
renders a turn panel or composer; the harness still pings the host and starts one
turn per renderer load when the model catalog arrives.
Today draws the verdict only when its band is empty, so the busy, bad and acknowledged
captures read no headline; they count the open Interrupts as the Needs you cards plus
the Stops the line block and hold that count equal to the sidebar's Today count.
None of the smoke mornings holds the environment, so no packaged capture draws the
block; feed the packaged app a morning whose Held lane names an Interrupt to see it.
The supervision step pins services under the legacy `spi-code.sidebar.pins` key after
start; the pins store reads that key live until its first write under the `.v2` key,
so it must never persist the seed on read.
