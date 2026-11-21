# spicode-xia.17 Windows sandbox on Windows Server 2025

Observed in CI run `44831183060` on `windows-latest` x64, at head
`3b847954`, with the
`windows-2025-vs2026` image (Windows Server 2025, 10.0.26100.0), Node 22.22.0
and `@microsoft/mxc-sdk` 1.1.0. The Windows 11 client is unobserved. The
Windows package and packaged smoke passed. No Copilot seat or model turn was
available, so checks that require the Copilot session were not attempted.
The probe ran on Node 22.22.0 with no Electron, while the MXC SDK's README asks
for Node 24 or later, and the executor resolved to the source package's
`wxc-exec.exe` (see Packaged executor resolution below), so the packaged run
covers MXC's FFI library, not the packaged executor.

`package:win` now runs `scripts/windows-sandbox-probe.mjs` after extracting the
ZIP and passes it the exact binaries below
`app.asar.unpacked/node_modules/@microsoft/mxc-sdk/bin`. The probe prints its
result before the packaged smoke. Re-run it on Windows with `pnpm package:win`,
or read a CI result with `gh run view <run id> --log`.

## Decision

**Windows remains ask-and-read.** SPI Code's own Copilot preflight resolves the
policy but returns `not-confined / unsupported-platform`; the production tool
list is empty. The package's existing Windows runtime evidence therefore still
requires `unsupported-platform`, not a proven command. This bead did not
loosen that gate and did not change `scripts/package.mjs` to accept a proven
Windows confinement result.

MXC 1.1.0 itself was loadable from the packaged x64 native library. Its host
capability probe reported Hyperlight and WSLC, but no ProcessContainer:
`baseContainerApiPresent: false` and
`Windows ProcessContainer is unavailable: PSEC is not enabled`. The
filesystem, environment, network and Git commands below therefore did not run
inside a sandbox. “Not run” is not a pass.

## Packaged MXC

| Check | Observed | How |
| --- | --- | --- |
| Required x64 payload | `wxc-exec.exe` (12,700,520 bytes), `mxc_ffi.dll` (8,278,336 bytes) and `wxc-windows-sandbox-daemon.exe` (1,611,072 bytes) existed in the extracted app. The other staged names passed `assertPackagedMxc`. | `assertPackagedMxc`, then direct `stat` from the probe against the extracted `app.asar.unpacked` tree. |
| Staged `dotnet` directory | Absent. | Direct `readdir` of the extracted x64 payload. |
| Packaged executor resolution | The extracted `wxc-exec.exe` existed, but an explicit resolver attempt with that `app.asar.unpacked` bin fell back to the source-package executable. `verifyExecutable` rejects every path containing `.asar`, including `.asar.unpacked`. | The probe compared the packaged candidate with `findWxcExecutable` before and after setting `MXC_BIN_DIR`. |
| Backend and tier | No ProcessContainer tier. MXC reported only Hyperlight and WSLC; the request probe said `PSEC is not enabled`. | Packaged `mxc_ffi.dll`, through `getPlatformSupport`, `getAvailableBackends` and `probe`. |
| Telemetry consent and required telemetry | Consent was `undetermined`, prompting was allowed and `telemetry: { enabled: false }` could not disable the four Required events. The consent string describes consented telemetry; the package does not document what the four Required events carry. PSEC prevented a ProcessContainer run on which to intercept an event. | `getTelemetryConsentStatus`, the installed 1.1.0 README/binary consent text, and the failed request-aware probe. No telemetry values or credentials were printed. |

## Confinement checks

| Check | Observed | How |
| --- | --- | --- |
| `sandboxConfig` resolution | Resolved with bypass, developer access, Git auth and gh auth off; read/write grants only for thread temp, linked worktree and clone `.git`; read-only grants for toolchain/clone/Git control files; app data denied; outbound restricted to the configured SPI hosts and local network denied. | The built host's `buildSandboxConfig` with disposable Windows clone, worktree, app-data and temp paths. |
| Sandbox attestation | Did not engage: `unsupported-platform`. | `runSandboxPreflight` returns `unsupported-platform` off Darwin; the probe's own constant is not an observation. |
| Worktree write | Not run. | MXC ProcessContainer refused before the PowerShell positive control: PSEC disabled. |
| Thread-temp write | Not run. Skipped after the first ProcessContainer refusal. | No later request was made. |
| Outside write | Not run. Skipped after the first ProcessContainer refusal. | No later request was made. |
| Sibling read | Not run. Skipped after the first ProcessContainer refusal. | No later request was made. |
| `appData/kube/config` read | Not run. Skipped after the first ProcessContainer refusal. | The .4/.12 live row cannot be repeated on Windows until MXC ProcessContainer starts. |
| `appData/azure/probe` read | Not run. Skipped after the first ProcessContainer refusal. | The list/read row cannot be repeated until ProcessContainer starts. |
| Environment and credentials | Not run. Skipped after the first ProcessContainer refusal. No credential values were requested or printed; the probe config intentionally passed only `SystemRoot`, `PATH`, app temp and temp directories. | No later request was made. |
| Network | Not run. Skipped after the first ProcessContainer refusal. Hyperlight/WSLC availability was not substituted for the requested ProcessContainer policy. | No later request was made. |
| Git commit | Not run. Skipped after the first ProcessContainer refusal. | No later request was made. |
| Clone config write | Not run. Skipped after the first ProcessContainer refusal. | No later request was made. |
| Worktree `.git` pointer write | Not run. Skipped after the first ProcessContainer refusal. | No later request was made. |
| Clone `.git/hooks` write | Not run. Skipped after the first ProcessContainer refusal. | No later request was made. |
| Timed-out command output | Not run. Skipped after the first ProcessContainer refusal. | The 500 ms MXC workload was not launched. |
| Stopped model command output | Not run. | Requires a signed-in Copilot model turn; CI has no seat. |
| Cold resume | Not run. | Requires a signed-in Copilot session and model catalog; CI has no seat. |

## Process ownership

| Ownership case | Observed | How |
| --- | --- | --- |
| Copilot `session.abort()` / stop | Not run. | Requires the built-in model tool and Copilot seat; neither is available in CI. |
| MXC `MxcProcess.kill()` | Not run. | `spawn` was not attempted after the ProcessContainer PSEC refusal. |
| MXC timeout descendant | Not run. | The timed workload never started. |
| Foreground descendant, host owner killed | Survived; a fresh PowerShell observer still found it. | A marked child PowerShell wrote its PID, its waiting owner was terminated, and the host queried Win32_Process by PID. |
| Redirected descendant, host owner killed | Survived; a fresh PowerShell observer still found it. | The child had stdout/stderr redirected and the owner waited; the host killed the owner and queried the child's PID. |
| Detached descendant, host owner exits normally | Survived; a fresh PowerShell observer still found it. | PowerShell `Start-Process` returned to an exiting owner; the host queried the recorded PID and then cleaned up the child with `taskkill /T /F`. |
| Host observer restarted after each owner stop/exit | All three marked descendants remained observable. | A new PowerShell process, not the original owner, queried each PID. This is a host-command ownership observation, not MXC ownership. |

The ownership rows are evidence about Windows orphaning, not a substitute for
MXC or Copilot ownership. The observed survivors are why command tools cannot be
offered as “owned” merely because their launcher exited. All probe-created
processes were removed after their observation.

