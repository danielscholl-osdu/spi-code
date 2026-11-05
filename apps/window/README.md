# M0 window

The minimal React window lists models through the host, sends prompts, and shows
streamed text and gated tool outcomes. Refresh sign-in and models re-reads gh;
when CP-03 replaces the runtime, the host announces that the previous session
ended. Only validated contract messages cross the MessagePort. Tool arguments,
results, SDK errors and credentials are not forwarded to the renderer.

From the repository root:

```
SPI_CODE_STUB_MODEL=1 pnpm --filter @spi-code/desktop smoke
pnpm --filter @spi-code/desktop start --live-report /tmp/spi-code-live.json
```

Stub mode uses the existing fake-session harness and the production registry and
permission policy: Read stubs complete; unsafe tiers are reached but refused.
Smoke requires every appendix A tool and a refused shell built-in, alongside the
existing process, malformed-message and SQLite checks.

`--live-report` automatically sends a short prompt requesting `spi_brief` with
the first returned model. It records sign-in, model count, streamed delta count
and observed tool outcomes, captures the rendered window to `<report>.png`, then
exits. It fails if the turn does not stream or reach a tool. Without this flag,
the window stays interactive. Live evidence contains no prompt, response, tool
arguments, tool results or token.
