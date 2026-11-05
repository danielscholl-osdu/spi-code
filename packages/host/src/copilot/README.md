# Copilot runtime boundary

The host starts the SDK 1.0.26 platform package's `prebuilds/<platform>/copilot-runtime`
(`.exe` on Windows) by absolute `connection.path`, over stdio. Empty mode uses
`<appDataDir>/copilot`; the environment comes from `buildToolEnvironment`.
Only the runtime child's environment redirects `HOME`, `USERPROFILE`,
`XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `LOCALAPPDATA`, `APPDATA`
and `COPILOT_HOME` beneath app data. This includes the runtime's macOS caches
and Microsoft device ID. Token lookup uses a separate scrubbed environment
with the operator's original home and gh configuration.
The packaging bead must leave the complete platform runtime package unpacked.
Startup cleanup, credential-keyed warm-client handling, and streamed delta
subscription are ported from Keelson's `copilot/factory.ts` and `provider.ts`.

`SessionToolSource` is the tool registry integration point. Its default stub
offers no tools and denies all permission requests.

## CP-03 fallback

The bundled runtime 1.0.103 rejects a provider credential with `expiresIn: 60`:
it requires **more than 3,600 seconds** remaining. Claiming an hour of remaining
lifetime for a gh credential would not establish the short refresh interval
required by CP-03. The host therefore uses CP-03's client-level fallback.

Each model listing and session creation reads gh again. Credential changes stop
the previous client (including its sessions) before starting another. Operations
are serialized so a concurrent account switch cannot interrupt session creation
or model listing. Model listings always call `rpc.models.list({ gitHubToken })`;
there is no host model cache. The SDK 1.0.26 passes the client-level token to the
runtime in its `COPILOT_SDK_AUTH_TOKEN` environment variable; it is never saved
by the host. Under this fallback, any process the runtime spawns would inherit
the token. That is safe today only because production sessions expose custom
tools alone (CP-04) and the runtime's base directory is the app-owned
`<appDataDir>/copilot`, not the operator's config directory. The runtime ignores
`HOME` and `COPILOT_HOME` for Copilot configuration in favor of that base directory.
Other caches and the device ID still follow the isolated home. Empty mode can still
spawn MCP servers configured there, even with `availableTools: []`. The app must
never write `mcp-config.json` or any MCP configuration there: a server spawned
from it would inherit `COPILOT_SDK_AUTH_TOKEN`. The isolation-only probe allows
MCP tools to test discovery, but discovers no servers in the clean base directory.
Tokens are validated before client construction and outward errors are
recursively redacted, including their stacks, causes and aggregate errors.
The runtime can create a session without a valid credential, but authentication
fails at its first turn; the live probe checks both the listing and the turn.

Run `pnpm --filter @spi-code/host probe:copilot` on a machine signed into gh with
a Copilot seat. The probe uses disposable OS-temp HOME and app-data directories,
redacts token values, scans app data before deleting it, and exits nonzero when
its evidence cannot be established.

Run `SPICODE_LIVE_COPILOT_ISOLATION=1 pnpm vitest run packages/host/src/copilot/isolation.test.ts`
to check filesystem isolation with the real runtime. It skips unless explicitly
enabled and gh credentials are available; enabling it requires network access
and a Copilot seat. It opens a session, lists models, stops the runtime, and
compares file listings in a disposable scratch home outside app data, printing
the before/after evidence and app-data listing. It never uses the operator's
real home for the runtime or alters their Copilot cache.
