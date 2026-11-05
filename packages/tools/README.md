# Install probe

```sh
scratch=$(mktemp -d)
pnpm --filter @spi-code/tools probe:install "$scratch"
```

The M0 probe supports macOS arm64 and x64. It downloads uv 0.13.7 from the pinned
per-platform manifest, verifies SHA-256 before extracting regular files and
directories, and publishes the installation only after finding its executable.
Failed installations remove their staging directory; existing installations
are not overwritten.

uv installs managed Python 3.12 and Azure CLI 2.92.0 with pip, then Azure CLI
installs `k8s-configuration`. Python's patch version and the extension version
are resolved at install time and recorded in the report. All uv stores, Azure
configuration, home, caches and temporary files are beneath the supplied app-data
directory. No Homebrew or administrator rights are used.

The probe prints JSON with `az version`, extension metadata, installer environment
and canonical executable paths. It exits non-zero if installation fails or any
executable resolves outside app data. Use an empty scratch directory for each run.
The scratch directory is retained for inspection; remove it when finished.

The installer ports T3 Code's verify-then-extract-and-publish shape from
`apps/server/src/provider/providerInstallation.ts` and `CodexInstallation.ts`;
its source retains the T3 Tools Inc. MIT notice.
