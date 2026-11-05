# Window shell

The three-pane Shore shell opens on Today and provides seven routes: Today,
Repositories, Releases, Environment, Flow, Horizon and Setup. Each route owns its
view folder; the shell owns the route table. Views and the inspector are placeholders
until their M2 beads land. Appearance follows the system unless pinned in the title
bar; the pin is saved in localStorage.

The Zustand Watch store keeps the highest snapshot cursor and the latest cursorless
sweep and setup states. Each `host.hello` sends a validated `view.subscribe` from
the retained cursor (zero before the first snapshot). Snapshot bodies remain opaque
until BRIEFSCHEMA lands. The sender is injected for fake-port tests.

The expandable Copilot turn panel lists models through the host, sends prompts, and shows
streamed text and gated tool outcomes. Refresh sign-in and models re-reads gh;
when CP-03 replaces the runtime, the host announces that the previous session
ended. Only validated contract messages cross the MessagePort. Tool arguments,
results, SDK errors and credentials are not forwarded to the renderer.

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

`--live-report` automatically sends a short prompt requesting `spi_brief` with
the first returned model. It records sign-in, model count, streamed delta count
and observed tool outcomes, captures the rendered window to `<report>.png`, then
exits. It fails if the turn does not stream or reach a tool. Without this flag,
the window stays interactive. Live evidence contains no prompt, response, tool
arguments, tool results or token.
