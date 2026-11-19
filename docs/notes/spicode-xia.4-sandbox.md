# spicode-xia.4 Copilot sandbox on macOS

Live on macOS 27.2 arm64 with the repository's Copilot SDK 1.0.26. The
probe loaded the built host's `CopilotRuntime.openThreadSession`, passed the
existing github.com keychain credential to its token source in memory, and
confirmed that the signed-in account returned a model catalog. It used a
disposable app directory, clone, linked worktree and thread temp directory.
The native `bash`, `create` and `view` calls went through
`session.rpc.tools.execute` on the SDK session opened by the host. The probe
approved only its own calls and sent no model turn during these checks.

| Check | Observation |
| --- | --- |
| Attestation | The outside-write probe failed to create its canary. Its own `sandbox.decision` events reported `user_policy` and `seatbelt`, followed by `enforcement_state: engaged`. |
| Writes | Shell redirection and native `create` both failed outside the worktree and left no file. The configured thread temp was writable through `TMPDIR`. The runtime's own temp directory was unwritable from the command. |
| Reads | Shell `cat` and native `view` both failed on a sibling canary. Listing the existing operator `~/.ssh` failed. |
| Environment and credentials | A names-only Bash `compgen -e` check found neither of the injected launch canaries, `COPILOT_SDK_AUTH_TOKEN`, nor any unapproved SDK credential variable. The runtime's Git configuration exposed no active credential helper. The probe printed no credential values. |
| Network | `curl -fsSI` reached `github.com`. The request to `example.com` failed through the proxy and with `--noproxy '*'`. |
| Git | A scratch commit advanced the linked worktree's HEAD. A hook write left no file, and `git config` failed with the clone's config unchanged. |
| Cold resume | After stopping the runtime, the host reopened the same SDK session ID with its workspace and observed a fresh Seatbelt attestation. |

The restart check then ran the built Copilot host module in a separate
process, reopened the session, started a one-word model turn, and sent
`SIGKILL` after `assistant.turn_start`. A new process resumed the same SDK
session ID and obtained a fresh `seatbelt` attestation. This exercised the
runtime adapter. The thread routes and their restart handling are owned by
spicode-xia.6. Windows sandbox verification is owned by spicode-xia.17.
