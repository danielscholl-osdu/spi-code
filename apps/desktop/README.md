# Desktop process spike

`pnpm --filter @spi-code/desktop start` compiles the host and desktop with
`tsc -b`, builds the window with Vite, and starts unpackaged Electron.
The sandboxed window talks directly to the utility process over a transferred
MessagePort. Contracts are validated in the window and host; preload exposes
only `postMessage` and `onMessage`. No network server is started.

On macOS, run:

```sh
SPI_CODE_SMOKE_REPORT=/tmp/spi-code-smoke.json pnpm --filter @spi-code/desktop smoke
```

Alternatively pass `--smoke-report /absolute/path/report.json` to the smoke
script. The smoke uses a fresh directory under Electron's app-data directory,
checks a renderer ping and malformed-message rejection, kills and restarts the
host, and verifies its SQLite row and event survived. It checks both live process
ids with `lsof` before and after restart. The success report is asserted before
being written, and includes Electron's main and utility-process Node versions
and the observed `DatabaseSync.isTransaction` support. Failure writes an `error`
report and exits nonzero; success exits zero. Smoke databases remain under
app data for inspection.
