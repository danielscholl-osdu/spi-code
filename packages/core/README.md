# @spi-code/core

SPI domain facts, models and briefing for plain Node, compiled as ESM with
TypeScript declarations.

## Exec progress and credentials

`ExecOptions.onOutput(stream, text)` receives redacted stdout and stderr while
the host command runs. Potential credential fragments are held across chunks;
unterminated credentials and authorization lines flush when the command ends.
Buffered stdout remains unchanged for existing parsers. `signal` cancels the
host process tree; a pre-aborted signal does not start a command or consume a
replay entry. Recording forwards cancellation to its runner and replays deliver
the recorded stdout and stderr through the same callback (without timing or
cross-stream ordering guarantees).

Stdin is transient: its trimmed value is stripped from recordings, progress,
stderr and errors even when it has no recognizable token prefix. Never persist
or log the original options. The additive `setup.signin` request accepts an
optional `token` only for `glab` (1-4096 characters, no whitespace); setup state
and progress messages remain strict and have no credential field.

## Vendoring version 0.1.0

From the repository root, run:

```sh
pnpm --filter @spi-code/core run pack
```

This builds core and runs `pnpm pack` on a temporary release staging directory.
The result is `packages/core/release/spi-code-core-0.1.0.tgz`; the script prints its
SHA-256. Vendor that tarball and pin it with a `file:` dependency in the consumer.
`node scripts/pack.mjs <release-directory>` from this package accepts an alternate
output directory.

The workspace manifest retains `@spi-code/contracts` for the workspace dependency
graph, but core currently imports neither its runtime code nor its types.
The release manifest omits that unused workspace dependency rather than requiring
an unpublished contracts version from npm. Packing fails if compiled JavaScript
or declarations reference contracts. No core runtime behavior is changed.
`yaml` and `zod` remain exact-version registry dependencies; an initial consumer
install needs registry access or a populated npm cache.

Only compiled code, declarations, this README and the MIT license ship. Tests,
fixtures and source maps are excluded. Use the `run pack` script above, not a
direct `pnpm pack` in the workspace: the latter retains the workspace dependency.

`test/pack.test.ts` installs the tarball into an empty temporary npm project with
its own cache, then imports `buildBriefing`. It runs with `scripts/check`. If the
npm registry cannot be reached, it reports a skip for the install proof after
checking the archive; run it again with registry access before release.
