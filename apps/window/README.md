# Window

The renderer: a top row, a sidebar of things, the middle frame and the right panel.
`design/spi-code-window-layout.html` is the layout authority. The location hash holds
the route; `src/app/navigation.tsx` parses it and `src/app/routes.tsx` picks the
middle frame's view. Settings is a dialog over the current place, not a route.

No page renders a Copilot turn panel or composer. `ProofTurnHarness` in
`src/index.tsx` mounts only when `window.spi.proof` is set, for the packaged smoke
and live proof runs.

From the repository root:

```sh
pnpm --filter @spi-code/desktop smoke
pnpm --filter @spi-code/desktop start --live-report /tmp/spi-code-live.json
```

`--live-report` needs gh sign-in and a Copilot seat. It sends one short prompt,
records sign-in, model count, delta count and tool outcomes, captures the window to
`<report>.png`, then exits. The report holds no prompt, response, tool arguments,
tool results or token.
