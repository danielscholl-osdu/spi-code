# Copilot runtime boundary

The host starts the SDK platform package's `prebuilds/<platform>/copilot-runtime`
by absolute path, over stdio. Only the runtime child's environment redirects the
home, XDG, app-data and `COPILOT_HOME` variables beneath app data. Token lookup uses
a separate scrubbed environment with the operator's original home and gh
configuration. Tokens stay out of these environment objects; only the SDK's client
credential receives one.

## CP-03 fallback

The bundled runtime rejects a provider credential with less than 3,600 seconds
remaining, so a gh credential cannot carry CP-03's short refresh interval. The host
uses CP-03's client-level fallback instead: each model listing and session creation
reads gh again, and a changed credential stops the previous client before another
starts.

Under this fallback the SDK passes the token to the runtime in
`COPILOT_SDK_AUTH_TOKEN`, so any process the runtime spawns inherits it. That is
safe only because production sessions expose custom tools alone (CP-04) and the
runtime's base directory is the app-owned `<appDataDir>/copilot`. The app must never
write `mcp-config.json` or any MCP configuration there: a server spawned from it
would inherit the token.

## Live probes

Both need gh sign-in, a Copilot seat and network access, and use disposable homes.

```sh
pnpm --filter @spi-code/host probe:copilot
SPICODE_LIVE_COPILOT_ISOLATION=1 pnpm vitest run packages/host/src/copilot/isolation.test.ts
```
