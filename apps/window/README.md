# Window shell

The shell follows T3 Code's layout: a 44 px top row drawn in the window's own title bar
space (beside the macOS traffic lights, or under the Windows caption overlay) and
draggable except on its controls. It holds the strip and toggles for the sidebar (⌘B) and
right panel (⌘I), using Ctrl on Windows; the document title names the current place.
Below it sit a 232 px sidebar of things, the middle frame and the right panel.
The sidebar lists Find or ask (⌘K), Today, Line, Places (Upstream, Environment,
Engineering system, Releases, Security), the services the operator pinned, and a footer
row that opens Settings (⌘,) with a readiness dot. Places and Pinned scroll between the
header and the footer. The groups fold, and the fold is saved in localStorage; on a window
shorter than 640 px Places folds unless the operator chose otherwise. The width budget
(`app/width-budget.ts`) puts the sidebar off-canvas when the centre would still be
narrower than 520 px after the right panel becomes a sheet and the Line sheet stacks;
Escape closes it there.

The location hash holds the route: `today`, `upstream`,
`environment`, `engineering-system` (`template` still opens it), `releases`,
`releases/<forming-releases|shared-components>`, `release/<month>`, `security` and
`service/<id>`. `app/navigation.tsx` parses it and `app/routes.tsx` picks the middle
frame's view. A retired hash (`inbox`, `lens/<flow|repositories|horizon>`) or an unknown
one opens Today. Settings, with Readiness, Sweep and Appearance, is a dialog over the
current place, not a route. Appearance follows the system unless the operator picks light
or dark in Settings, Appearance; the choice is saved in localStorage.

The Line sheet opens over any surface with ⌘L (Ctrl+L on Windows), without
replacing the centre or its selection. Escape or Close returns to that surface.
Pin keeps the centre live beside the sheet; Unpin closes it. The pin survives a
reload. Quiet service rows fold into one expandable line. Detected campaign chips
filter to their member forks, with membership in a separate column; selecting the
chip again clears the filter. Station glyphs name their typed sub-state, and cells
open their own Detail reading. The campaign filter test uses the recorded
`CodeQL: java/log-injection` campaign in `fixtures/watch/snapshot-59d6895.json`,
whose member forks are file, partition and schema.

The Zustand Watch store keeps the highest snapshot cursor and the latest cursorless
sweep and setup states. Each `host.hello` sends a validated `view.subscribe` from
the retained cursor (zero before the first snapshot). Snapshot bodies remain opaque
until BRIEFSCHEMA lands. The sender is injected for fake-port tests.

The expandable Copilot turn panel lists models through the host, sends prompts, and shows
streamed text and gated tool outcomes. Refresh sign-in and models re-reads gh;
when CP-03 replaces the runtime, the host announces that the previous session
ended. Only validated contract messages cross the MessagePort. Tool arguments,
results, SDK errors and credentials are not forwarded to the renderer.
Streamed text and tool events are accepted only for the window's active turn,
so an earlier turn cannot populate a reloaded window or a later response.

From the repository root:

```
pnpm --filter @spi-code/desktop smoke
pnpm --filter @spi-code/desktop start --live-report /tmp/spi-code-live.json
```

Stub mode uses the existing fake-session harness and the production registry and
permission policy: Read stubs complete; unsafe tiers are reached but refused.
Smoke selects it explicitly. Normal packaged launches ignore the stub environment
flag; unpackaged development may enable it with `SPI_CODE_STUB_MODEL=1`. The
window labels the stub without claiming gh sign-in.
Smoke requires every appendix A tool and a refused shell built-in, alongside the
existing process, malformed-message and SQLite checks.
It also reloads the window and round-trips over a new host port, requests a
renderer permission and observes its denial, and checks that a permission query
reports denied. Round-trips, rejection and TCP
listeners in the report come from the probes; a failed observation fails the
report check. The desktop denies all session permission requests by default.
Smoke waits for probe replies by message ID, including error replies, before
checking their types and outcomes rather than waiting only for successful results.

`--live-report` automatically sends a short prompt requesting `spi_brief` with
the first returned model. It records sign-in, model count, streamed delta count
and observed tool outcomes, captures the rendered window to `<report>.png`, then
exits. It fails if the turn does not stream or reach a tool. Without this flag,
the window stays interactive. Live evidence contains no prompt, response, tool
arguments, tool results or token.
