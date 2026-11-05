# Copilot runtime boundary

The host starts the SDK 1.0.26 platform package's `prebuilds/<platform>/copilot-runtime`
(`.exe` on Windows) by absolute `connection.path`, over stdio. Empty mode uses
`<appDataDir>/copilot`; the environment comes from `buildToolEnvironment`.
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
there is no host model cache. A client-level token is passed in memory to the SDK,
which supplies it to its child process; it is never saved by the host.
The runtime can create a session without a valid credential, but authentication
fails at its first turn; the live probe checks both the listing and the turn.

Run `pnpm --filter @spi-code/host probe:copilot` on a machine signed into gh with
a Copilot seat. The probe uses disposable OS-temp HOME and app-data directories,
redacts token values, scans app data before deleting it, and exits nonzero when
its evidence cannot be established.
