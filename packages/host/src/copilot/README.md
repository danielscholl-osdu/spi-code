# Copilot runtime boundary

The host starts the SDK platform package's `prebuilds/<platform>/copilot-runtime`
by absolute path over stdio. The client runs in empty mode under
`<appDataDir>/copilot`. The runtime gets the managed PATH, locale and Windows
startup variables, an app-owned home, and a Git configuration with credential
helpers disabled. Credential lookup uses a separate environment with the
operator's home and gh configuration.

## Thread sessions

`CopilotRuntime.openThreadSession(workspace, options)` requires the host-managed
workspace on create and resume. The caller supplies existing clone, worktree,
thread temp and toolchain paths as applicable. To change the policy, release the
session and open it with the current workspace and its previous SDK session ID.

The returned handle owns the SDK session. Its `sandbox` property contains the
current typed state and `send` checks that state before sending a turn. The
thread can use the state's `reason` to explain unavailable shell and file tools.
Use `release` to disconnect and discard the proof.

The first shell call on macOS is a host-only preflight. It checks a write
outside the workspace, verifies the correlated Seatbelt policy and enforcement
events, and checks exported variable names. The initial tool list is never sent
to a model. A successful check enables file reads for Asking and adds the shell
and file writes for worktree threads. Windows keeps custom tools only.

## CP-03 credentials

The SDK's provider rejects credentials with less than 3,600 seconds remaining.
Thread sessions instead get the existing gh credential through the session RPC.
The runtime launches without a client-level token. The host reads gh again on
create, resume, model listing and before each turn. A changed credential retires
the warm runtime and its sessions. Reopen the thread to continue with the
current credential. Model listing also receives the current token explicitly.

The legacy conversation and seat probe use the client-level fallback with
custom tools only. That fallback puts `COPILOT_SDK_AUTH_TOKEN` into the runtime
process environment. Keep its app-owned base directory free of MCP configuration.

## Live evidence

The thread sandbox checks are recorded in
[spicode-xia.4-sandbox.md](../../../../docs/notes/spicode-xia.4-sandbox.md).
The earlier runtime and isolation probes are separate from those checks.

```sh
pnpm --filter @spi-code/host probe:copilot
SPICODE_LIVE_COPILOT_ISOLATION=1 pnpm vitest run packages/host/src/copilot/isolation.test.ts
```
