# Desktop main

`pnpm --filter @spi-code/desktop start` compiles the host and desktop with
`tsc -b`, builds the window with Vite, and starts unpackaged Electron.
`src/index.ts` reads the flags and calls `createDesktop` from `src/start.ts`,
which owns the window, the tray and the host supervisor. The smoke sequence is
`runSmoke` in `src/smoke-run.ts`, imported only under `--smoke`.
The sandboxed window talks directly to the utility process over a transferred
MessagePort. Contracts are validated in the window and host. `src/preload.cjs`
exposes seven members on `window.spi`: `proof`, `openExternal`, `setAppearance`,
`postMessage`, `onMessage`, `onNavigate` and `onLeave`. No network server is started.

On macOS, run:

```sh
SPI_CODE_SMOKE_REPORT=/tmp/spi-code-smoke.json pnpm --filter @spi-code/desktop smoke
```

`--smoke` explicitly selects the stub model, with no Copilot seat or environment
flag required. Packaged normal launches ignore inherited `SPI_CODE_STUB_MODEL`;
unpackaged development may set it to `1`. Stub sign-in is labelled as a stub,
not as gh authentication.

Alternatively pass `--smoke-report /absolute/path/report.json` to the smoke
script. The launcher uses a fresh temporary Electron user-data directory,
checks a renderer ping and malformed-message rejection, kills and restarts the
host, and verifies its SQLite row and event survived. It checks both live process
ids with `lsof` on macOS or `netstat -ano` on Windows before and after restart.
Windows smoke rejects unrecognized or localized TCP state labels explicitly.
The success report is asserted before
being written, and includes Electron's main and utility-process Node versions
and the observed `DatabaseSync.isTransaction` support. Failure writes an `error`
report and exits nonzero; success exits zero. The launcher removes its temporary
user-data directory after Electron exits, including on failure.

The PM-03 smoke seeds a fixture Watch snapshot in SQLite and displays it in the
real window. It sends `SIGKILL` to the actual utility-process PID and lets the
production `HostSupervisor` restart it after its real first backoff. It asserts
a new PID and MessageChannel peer pair, the window's outgoing `view.subscribe`
cursor, a newer displayed snapshot, the same renderer PID and document without
a reload, and the original SQLite run, event and snapshot rows. It then
exhausts the real supervisor's crash budget and checks that `host_unavailable`
is displayed both before and after a renderer reload. Only this remaining
give-up probe accelerates restart timers; the stable-run timer is never shortened,
and no accelerated clock exists without `--smoke`.

The smoke also verifies that each main-frame reload transfers exactly one fresh
host channel, while a late iframe load transfers none. Reconnects wait for the
main-frame navigation's `did-stop-loading`, not `did-finish-load`, and renderer
crashes clear any pending reconnect until the next main-frame navigation.

The host's explicit `--smoke --stub-model` path bypasses live Setup and forbids
external commands: no real gh/glab, seat lookup or sweep runs. Normal and
development-stub launches retain production Setup. The in-app deadline and the
launcher timeout are both `SMOKE_TIMEOUT_MS` in `src/smoke-report.ts`. The `supervision` section of
the JSON report is required by both the local and packaged smoke gates.

`pnpm run package:mac` builds unsigned macOS arm64 DMG and ZIP artifacts under
`build/package-mac/artifacts`, using an isolated, hoisted production dependency
layout. The preload and window are shipped inside `app.asar`; the SDK platform
prebuilds are explicitly unpacked beside it. Signing discovery is disabled and
`ELECTRON_RUN_AS_NODE` is removed before launching the packaged executable.

The packaged host bootstrap performs a real SDK stdio `ping` and `getStatus`
handshake against that shipped runtime before the stub-driven smoke starts.
The script reads both reports back, validates the existing smoke assertions,
checks the runtime path and host pid, and writes the combined evidence to
`build/package-mac/smoke.json`. A missing or failing report fails the command;
no live sign-in is needed. Normal packaged launches still use gh authentication.
`pnpm run package:win` runs the same gate on Windows x64, producing an NSIS
installer and a ZIP under `build/package-win/artifacts` and combined evidence
at `build/package-win/smoke.json`. Both commands smoke the app extracted from
the shipped ZIP and require the matching unpacked SDK runtime's stdio handshake.

The `Packaged smoke` Actions workflow has independent `package` and `check`
jobs, each on `macos-latest` arm64 and `windows-latest` x64 for `main`, `bead/**`,
and manual dispatches. `package` builds the app and runs this packaging gate,
uploading artifacts and smoke/runtime reports with the commit SHA. `check`
runs the full `scripts/check` suite and remains blocking independently of
packaging; packaging success alone cannot pass the SDK gate. No credentials
or live Copilot turn are required; macOS builds remain unsigned.
