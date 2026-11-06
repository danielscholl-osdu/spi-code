# @spi-code/core

SPI domain facts, models and briefing for plain Node, compiled as ESM with
TypeScript declarations.

## Station substates

`stationSubstateOf(station, line, facts)` distinguishes stopped work, work waiting
on a person, work waiting on the daily upstream sync, work in progress and
stations with nothing to do. It uses typed model fields and recorded checks,
runs, approvals and upstream predictions, never station text. Release PRs still
need a person to merge after approval; an approved, green, clean Sync to Main PR
can progress automatically when the repository allows auto-merge.
An active lane follows its pending Validation checks, not the PR's review or
draft state; only a waiting Validation check or a current-head workflow approval
makes that lane wait on a person.
An unread station retains the neutral `ready` substate; its legacy `unknown`
state and evidence still describe the missing read, not confirmed health.

## Exec progress and credentials

`ExecOptions.onOutput(stream, text)` receives redacted stdout and stderr while
the host command runs. Potential credential fragments are held across chunks;
unterminated credentials and authorization lines flush when the command ends.
Buffered stdout remains unchanged for existing parsers. `signal` cancels the
host process tree; a pre-aborted signal does not start a command or consume a
replay entry. Recording forwards cancellation to its runner and replays deliver
the recorded stdout and stderr through the same callback (without timing or
cross-stream ordering guarantees).

Credential stdin is transient: trimmed values of at least eight characters are
stripped from recordings, progress, stderr and errors even without a recognizable
token prefix. Short interactive responses such as `y` are preserved.
Recordings store credential stdin as `<redacted>`, so replay does not verify its
contents. Never persist or log the original options.
The additive `setup.signin` request accepts an
optional `token` only for `glab` (8-4096 characters, no whitespace); setup state
and progress messages remain strict and have no credential field.

## Vendoring version 0.1.2

Each vendored tarball must carry a version not used before; never replace the
contents of an already-vendored version.

When a consumer vendors version X, add X's SHA-256 to `pack-shas.json` and bump
this package to the next patch version.

From the repository root, run:

```sh
pnpm --filter @spi-code/core run pack
```

This builds core and runs `pnpm pack` on a temporary release staging directory.
The result is `packages/core/release/spi-code-core-0.1.2.tgz`; the script prints its
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
checking the archive; run it again with registry access before release. It also fails
when the current version is recorded in `pack-shas.json` and packs to other bytes.
