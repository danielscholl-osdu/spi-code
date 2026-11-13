# Desktop main

The Electron main process. `src/index.ts` reads the flags and calls `createDesktop`
in `src/start.ts`, which owns the window, the tray and the host supervisor. The
sandboxed window talks to the host utility process over a transferred MessagePort;
no network server is started.

```sh
pnpm --filter @spi-code/desktop start      # unpackaged, against the real host
SPI_CODE_SMOKE_REPORT=/tmp/spi-code-smoke.json pnpm --filter @spi-code/desktop smoke
pnpm run package:mac                       # unsigned arm64 DMG and ZIP
pnpm run package:win                       # x64 NSIS installer and ZIP
```

- `--smoke` selects the stub model and forbids external commands: no gh, glab,
  seat lookup or sweep runs. Packaged normal launches ignore `SPI_CODE_STUB_MODEL`;
  unpackaged development may set it to `1`.
- The smoke sequence is `runSmoke` in `src/smoke-run.ts`, imported only under
  `--smoke`. No accelerated clock exists without that flag.
- Both package commands smoke the app extracted from the shipped ZIP and write the
  combined evidence to `build/package-<mac|win>/smoke.json`. A missing or failing
  report fails the command.
